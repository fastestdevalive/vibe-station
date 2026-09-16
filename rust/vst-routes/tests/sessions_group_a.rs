//! Behavior contract for `sessions.ts` Group A (dispatch #1).
//!
//! Ports the portable Group A slice of `daemon/src/routes/sessions.ts`:
//! `findSessionContext`, `findWorktreeContext`, `serializeSession` /
//! `serializeGlobalDraft`, `GET /sessions`, `GET /sessions/:id`,
//! `GET /sessions/:id/output` (json branch), and the draft branch of
//! `POST /sessions` (global + worktree + direct draft creation).
//!
//! NOT exercised here (require live processes / cross-part infra, `#[ignore]`d
//! where a test exists): the tmux/pty spawn jobs and the normal-branch agent
//! spawn, which depend on the as-yet-unported spawn orchestration being fully
//! wired to real PTYs/tmux. The pure channel-resolution + record-construction
//! of the normal branch is covered by unit-level asserts on `serialize_session`
//! and the create logic that does not spawn.

use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{
    find_session_context, find_worktree_context, group_json_output, serialize_global_draft,
    serialize_session, SessionRoutes,
};
use vst_routes::sessions::{CreateError, SessionOrDraft};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::shared::{GlobalDraft, Session};
use vst_types::{
    Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider,
    ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord, SessionType, WorktreeRecord,
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

// ---------------------------------------------------------------------------
// serialize_session
// ---------------------------------------------------------------------------

#[test]
fn serialize_session_flattens_lifecycle_and_wire_fields() {
    let mut s = make_session("s1", "p1");
    s.is_main = true;
    s.name = Some("My Agent".into());
    s.name_source = Some(SessionNameSource::User);
    s.lifecycle.state = LifecycleState::Done;
    s.pinned_at = Some("2026-02-01T00:00:00.000Z".into());
    s.parent_session_id = Some("parent-1".into());

    let out = serialize_session(Some("w1"), "p1", &s);
    assert_eq!(out.id, "s1");
    assert_eq!(out.worktree_id.as_deref(), Some("w1"));
    assert_eq!(out.project_id, "p1");
    assert!(out.is_main);
    assert_eq!(out.r#type, SessionType::Agent);
    assert_eq!(out.name.as_deref(), Some("My Agent"));
    assert_eq!(out.name_source, Some(SessionNameSource::User));
    assert_eq!(out.tmux_name, "vst-s1");
    assert!(out.use_tmux);
    assert_eq!(out.channel, Channel::Tmux);
    assert_eq!(out.state, LifecycleState::Done);
    assert_eq!(out.lifecycle_state, LifecycleState::Done);
    assert_eq!(out.created_at, "2026-01-01T00:00:00.000Z");
    assert_eq!(out.pinned_at.as_deref(), Some("2026-02-01T00:00:00.000Z"));
    assert_eq!(out.parent_session_id.as_deref(), Some("parent-1"));
    assert_eq!(out.mode_id.as_deref(), Some("m"));
}

#[test]
fn serialize_session_direct_has_null_worktree_id_and_json_channel() {
    let mut s = make_session("s1", "p1");
    s.use_tmux = false;
    s.channel = Some(Channel::Json);
    let out = serialize_session(None, "p1", &s);
    assert_eq!(out.worktree_id, None);
    assert_eq!(out.channel, Channel::Json);
    assert!(!out.use_tmux);
}

#[test]
fn session_wire_roundtrips_through_serde() {
    let s = make_session("s1", "p1");
    let out = serialize_session(Some("w1"), "p1", &s);
    let json = serde_json::to_value(&out).unwrap();
    let back: Session = serde_json::from_value(json).unwrap();
    assert_eq!(back, out);
}

// ---------------------------------------------------------------------------
// serialize_global_draft
// ---------------------------------------------------------------------------

#[test]
fn serialize_global_draft_produces_fixed_wire_shape() {
    let row = vst_store::global_drafts::GlobalDraftRow {
        id: "gd1".into(),
        draft_prompt: Some("build a thing".into()),
        draft_config: Some(r#"{"entryPoint":"global","useWorktree":true}"#.to_string()),
        name: Some("Draft".into()),
        name_source: Some("user".into()),
        sort_order: Some(123.0),
        created_at: "2026-01-01T00:00:00.000Z".into(),
    };
    let out = serialize_global_draft(&row);
    assert_eq!(out.id, "gd1");
    assert_eq!(out.worktree_id, None);
    assert_eq!(out.project_id, None);
    assert!(!out.is_main);
    assert_eq!(out.r#type, SessionType::Agent);
    assert_eq!(out.name.as_deref(), Some("Draft"));
    assert_eq!(out.name_source, Some(SessionNameSource::User));
    assert_eq!(out.tmux_name, "__draft__-gd1");
    assert!(!out.use_tmux);
    assert_eq!(out.channel, Channel::Json);
    assert_eq!(out.state, LifecycleState::Drafting);
    assert_eq!(out.lifecycle_state, LifecycleState::Drafting);
    assert_eq!(out.sort_order, 123.0);
    assert_eq!(out.draft_prompt.as_deref(), Some("build a thing"));
    assert!(out.draft_config.is_some());
}

#[test]
fn serialize_global_draft_falls_back_to_created_at_ms_for_sort_order() {
    let row = vst_store::global_drafts::GlobalDraftRow {
        id: "gd1".into(),
        draft_prompt: None,
        draft_config: None,
        name: None,
        name_source: None,
        sort_order: None,
        created_at: "1970-01-02T00:00:00.000Z".into(),
    };
    let out = serialize_global_draft(&row);
    assert_eq!(out.sort_order, 86_400_000.0);
}

#[test]
fn global_draft_wire_roundtrips_through_serde() {
    let row = vst_store::global_drafts::GlobalDraftRow {
        id: "gd1".into(),
        draft_prompt: Some("hi".into()),
        draft_config: None,
        name: None,
        name_source: None,
        sort_order: Some(1.0),
        created_at: "2026-01-01T00:00:00.000Z".into(),
    };
    let out = serialize_global_draft(&row);
    let json = serde_json::to_value(&out).unwrap();
    let back: GlobalDraft = serde_json::from_value(json).unwrap();
    assert_eq!(back, out);
}

// ---------------------------------------------------------------------------
// find_session_context / find_worktree_context
// ---------------------------------------------------------------------------

#[tokio::test]
async fn find_session_context_finds_worktree_direct_and_global() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let wt_session = make_session("s-wt", "p1");
    wt_session_clone(&mut w, &wt_session);
    let direct_session = make_session("s-direct", "p1");
    p.direct_sessions.push(direct_session);
    p.worktrees.push(w);
    store.add_project(p).await.unwrap();

    // Global draft
    let row = vst_store::global_drafts::GlobalDraftRow {
        id: "gd1".into(),
        draft_prompt: None,
        draft_config: None,
        name: None,
        name_source: None,
        sort_order: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
    };
    store.add_global_draft(&row).await.unwrap();

    let c1 = find_session_context(&store, "s-wt").await.unwrap();
    match c1 {
        vst_routes::sessions::SessionContext::Worktree {
            project, worktree, ..
        } => {
            assert_eq!(project.id, "p1");
            assert_eq!(worktree.id, "w1");
        }
        other => panic!(
            "expected worktree, got {:?}",
            std::mem::discriminant(&other)
        ),
    }

    let c2 = find_session_context(&store, "s-direct").await.unwrap();
    match c2 {
        vst_routes::sessions::SessionContext::Direct { .. } => {}
        other => panic!("expected direct, got {:?}", std::mem::discriminant(&other)),
    }

    let c3 = find_session_context(&store, "gd1").await.unwrap();
    match c3 {
        vst_routes::sessions::SessionContext::Global { row } => assert_eq!(row.id, "gd1"),
        other => panic!("expected global, got {:?}", std::mem::discriminant(&other)),
    }

    assert!(find_session_context(&store, "nope").await.is_none());
}

#[tokio::test]
async fn find_worktree_context_finds_and_returns_none() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    store.add_project(p).await.unwrap();

    let (project, worktree) = find_worktree_context(&store, "w1").await.unwrap();
    assert_eq!(project.id, "p1");
    assert_eq!(worktree.id, "w1");
    assert!(find_worktree_context(&store, "nope").await.is_none());
}

fn wt_session_clone(w: &mut WorktreeRecord, s: &SessionRecord) {
    w.sessions.push(s.clone());
}

// ---------------------------------------------------------------------------
// group_json_output
// ---------------------------------------------------------------------------

fn text_event(turn: Option<&str>, text: &str) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.provider = NormalizedEventProvider::Claude;
    e.kind = NormalizedEventKind::Text;
    e.turn_id = turn.map(str::to_string);
    e.text = Some(text.to_string());
    e
}

#[test]
fn group_json_output_joins_chunks_within_turn_but_not_across() {
    let events = vec![
        text_event(Some("t1"), "Hello "),
        text_event(Some("t1"), "world"),
        text_event(Some("t2"), "Second answer."),
    ];
    assert_eq!(group_json_output(&events), "Hello world\n\nSecond answer.");
}

#[test]
fn group_json_output_skips_non_text_and_empty() {
    let mut tool = NormalizedEvent::default();
    tool.kind = NormalizedEventKind::ToolUse;
    tool.text = Some("ignored".into());
    let events = vec![tool, text_event(Some("t1"), "real")];
    assert_eq!(group_json_output(&events), "real");
}

// ---------------------------------------------------------------------------
// GET /sessions listing via SessionRoutes::list_sessions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_sessions_returns_all_then_filters_by_project() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(make_session("s-wt", "p1"));
    p.worktrees.push(w);
    p.direct_sessions.push(make_session("s-dir", "p1"));
    store.add_project(p).await.unwrap();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: None,
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let all = r.list_sessions(None, None).await.unwrap();
    assert_eq!(all.len(), 3);

    let proj = r.list_sessions(None, Some("p1")).await.unwrap();
    assert_eq!(proj.len(), 2);

    let missing = r.list_sessions(None, Some("nope")).await;
    assert!(missing.is_err());
}

#[tokio::test]
async fn list_sessions_filters_by_worktree_and_errors_missing() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(make_session("s-wt", "p1"));
    p.worktrees.push(w);
    store.add_project(p).await.unwrap();

    let r = routes(store.clone());
    let wt = r.list_sessions(Some("w1"), None).await.unwrap();
    assert_eq!(wt.len(), 1);
    assert!(r.list_sessions(Some("nope"), None).await.is_err());
}

// ---------------------------------------------------------------------------
// GET /sessions/:id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_session_by_id_all_three_kinds() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(make_session("s-wt", "p1"));
    p.worktrees.push(w);
    p.direct_sessions.push(make_session("s-dir", "p1"));
    store.add_project(p).await.unwrap();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: None,
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store);
    let s1 = r.get_session("s-wt").await.unwrap();
    match s1 {
        SessionOrDraft::Session(s) => {
            assert_eq!(s.worktree_id.as_deref(), Some("w1"));
        }
        SessionOrDraft::GlobalDraft(_) => panic!("expected session"),
    }
    let s2 = r.get_session("s-dir").await.unwrap();
    match s2 {
        SessionOrDraft::Session(s) => assert_eq!(s.worktree_id, None),
        SessionOrDraft::GlobalDraft(_) => panic!("expected session"),
    }
    let s3 = r.get_session("gd1").await.unwrap();
    match s3 {
        SessionOrDraft::GlobalDraft(g) => assert_eq!(g.id, "gd1"),
        SessionOrDraft::Session(_) => panic!("expected global draft"),
    }
    assert!(r.get_session("nope").await.is_err());
}

// ---------------------------------------------------------------------------
// POST /sessions — draft branch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_draft_session_global_persists_and_serializes() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let body = serde_json::json!({
        "target": "global",
        "type": "agent",
        "state": "drafting",
        "draftPrompt": "make a plan",
        "draftConfig": { "entryPoint": "global", "useWorktree": true },
    });
    let created = r.create_session(&body).await.unwrap();
    match created {
        SessionOrDraft::GlobalDraft(g) => {
            assert_eq!(g.draft_prompt.as_deref(), Some("make a plan"));
            assert!(g.draft_config.is_some());
        }
        SessionOrDraft::Session(_) => panic!("expected global draft"),
    }
    // Persisted in the store.
    let drafts = store.get_all_global_drafts().await;
    assert_eq!(drafts.len(), 1);
}

#[tokio::test]
async fn create_draft_session_worktree_attaches_to_worktree() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    store.add_project(p).await.unwrap();

    let r = routes(store.clone());
    let body = serde_json::json!({
        "worktreeId": "w1",
        "type": "agent",
        "state": "drafting",
        "draftPrompt": "hi",
    });
    let created = r.create_session(&body).await.unwrap();
    match created {
        SessionOrDraft::Session(s) => {
            assert_eq!(s.worktree_id.as_deref(), Some("w1"));
            assert_eq!(s.state, LifecycleState::Drafting);
            assert_eq!(s.channel, Channel::Json);
        }
        SessionOrDraft::GlobalDraft(_) => panic!("expected session"),
    }
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.worktrees[0].sessions.len(), 1);
}

#[tokio::test]
async fn create_draft_session_worktree_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let body = serde_json::json!({
        "worktreeId": "nope",
        "type": "agent",
        "state": "drafting",
    });
    let err = r.create_session(&body).await.unwrap_err();
    assert!(matches!(err, CreateError::NotFound(_)));
}

#[tokio::test]
async fn create_draft_session_direct_attaches_to_direct_sessions() {
    let (_d, store) = store();
    store.add_project(make_project("p1")).await.unwrap();
    let r = routes(store.clone());
    let body = serde_json::json!({
        "projectId": "p1",
        "type": "agent",
        "state": "drafting",
        "draftPrompt": "hi",
    });
    let created = r.create_session(&body).await.unwrap();
    match created {
        SessionOrDraft::Session(s) => {
            assert_eq!(s.worktree_id, None);
            assert_eq!(s.state, LifecycleState::Drafting);
        }
        SessionOrDraft::GlobalDraft(_) => panic!("expected session"),
    }
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.direct_sessions.len(), 1);
}

#[tokio::test]
async fn create_draft_session_missing_project_and_worktree_is_400() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let body = serde_json::json!({
        "type": "agent",
        "state": "drafting",
    });
    let err = r.create_session(&body).await.unwrap_err();
    assert!(matches!(err, CreateError::Validation(_)));
}
