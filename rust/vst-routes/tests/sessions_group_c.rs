//! Behavior contract for `sessions.ts` Group C (dispatch #4).
//!
//! Ports the Group C slice of `daemon/src/routes/sessions.ts` (lines
//! 2226-2606): `sendHandler` (`POST /sessions/:id/send`), `POST .../chat`,
//! `.../chat/dismiss-notice`, `.../chat/promote-notice`, `.../chat/stop`,
//! `DELETE .../chat/queue/:turnId`, `.../chat/queue/:turnId/edit|resubmit|promote`,
//! `.../chat/fork`, and `PATCH .../chat/model`.
//!
//! These are mostly thin dispatch into `vst-agents::JsonAgentSession` /
//! `json_agent_chat` (part 04c). The route layer's genuine responsibility is
//! session lookup + HTTP status mapping + attachment-id validation + response
//! serialization — that is what's exercised here, against a store + an empty
//! (or populated) `JsonAgentRegistry`.
//!
//! NOT exercised (require a live `JsonAgentSession` whose drain loop spawns a
//! real process; `#[ignore]`d):
//! - the json send/chat happy path (enqueue → real spawn)
//! - queue-control (`cancel`/`edit`/`resubmit`/`promote`) against a live agent
//! - fork's turn-not-found + success paths (need a real agent + transcript)
//! - the model-200 path (needs a live agent)

use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{ChatRouteError, SessionRoutes};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::{ChatBody, InputBody, PatchModelBody, ResubmitBody};
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
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

fn json_session(id: &str, project_id: &str) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.use_tmux = false;
    s.channel = Some(Channel::Json);
    s
}

fn pty_session(id: &str, project_id: &str) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.use_tmux = false;
    s.channel = Some(Channel::Pty);
    s
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

/// Add a global draft to the store.
async fn add_global_draft(store: &StoreHandle, id: &str) {
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: id.into(),
            draft_prompt: Some("hi".into()),
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();
}

fn not_found(err: &ChatRouteError) -> bool {
    matches!(err, ChatRouteError::NotFound(_))
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/send
// ---------------------------------------------------------------------------

#[tokio::test]
async fn send_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r
        .send_session(
            "nope",
            InputBody {
                data: "hi".into(),
                send_enter: None,
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn send_global_draft_404() {
    let (_d, store) = store();
    add_global_draft(&store, "gd1").await;
    let r = routes(store.clone());
    let err = r
        .send_session(
            "gd1",
            InputBody {
                data: "hi".into(),
                send_enter: None,
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn send_json_archived_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.archived_at = Some("2026-02-01T00:00:00.000Z".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .send_session(
            "s1",
            InputBody {
                data: "hi".into(),
                send_enter: None,
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::Archived(_)));
}

#[tokio::test]
async fn send_attachments_require_json_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .send_session(
            "s1",
            InputBody {
                data: "hi".into(),
                send_enter: None,
                attachment_ids: Some(vec!["a1".into()]),
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::AttachmentsRequireJson(_)));
}

#[tokio::test]
async fn send_direct_pty_not_running_409() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(pty_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .send_session(
            "s1",
            InputBody {
                data: "hi".into(),
                send_enter: None,
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::NotRunning(_)));
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/chat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r
        .chat_session(
            "nope",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn chat_global_draft_404() {
    let (_d, store) = store();
    add_global_draft(&store, "gd1").await;
    let r = routes(store.clone());
    let err = r
        .chat_session(
            "gd1",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn chat_archived_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.archived_at = Some("2026-02-01T00:00:00.000Z".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .chat_session(
            "s1",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::Archived(_)));
}

#[tokio::test]
async fn chat_attachment_not_found_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .chat_session(
            "s1",
            ChatBody {
                message: "hi".into(),
                attachment_ids: Some(vec!["a1".into()]),
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::AttachmentNotFound(_)));
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/chat/dismiss-notice | promote-notice
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dismiss_notice_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.dismiss_notice("nope").await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn dismiss_notice_idempotent_no_agent_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    // No agent in the registry → still 204 (idempotent).
    r.dismiss_notice("s1").await.unwrap();
}

#[tokio::test]
async fn promote_notice_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.promote_notice("nope").await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn promote_notice_idempotent_no_agent_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    r.promote_notice("s1").await.unwrap();
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/chat/stop
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stop_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.stop_active_turn("nope", None).await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn stop_no_agent_409() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.stop_active_turn("s1", None).await.unwrap_err();
    assert!(matches!(err, ChatRouteError::NoActiveTurn(_)));
}

#[tokio::test]
async fn stop_turn_scoped_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.stop_active_turn("nope", Some("turn-1")).await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn stop_turn_scoped_no_agent_409() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.stop_active_turn("s1", Some("turn-1")).await.unwrap_err();
    assert!(matches!(err, ChatRouteError::NoActiveTurn(_)));
}

#[tokio::test]
async fn stop_turn_scoped_stale_turn_returns_stopped_false() {
    let dir = tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let plugin = Arc::from(vst_agents::resolve_plugin(vst_types::CliId::Claude));
    let session = vst_agents::json_agent_session::JsonAgentSession::new(
        vst_agents::json_agent_session::JsonAgentSessionOptions {
            project: make_project("p1"),
            worktree: None,
            session: json_session("s1", "p1"),
            plugin,
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle: store.clone(),
            broadcaster: vst_types::Broadcaster(tokio::sync::broadcast::channel(16).0),
        },
    );
    r.json_registry.set("s1".to_string(), Arc::new(session));

    let res = r.stop_active_turn("s1", Some("stale-turn-id")).await.unwrap();
    assert!(res.ok);
    assert!(!res.stopped);
}

// ---------------------------------------------------------------------------
// DELETE /sessions/:id/chat/queue/:turnId
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.cancel_queued_turn("nope", "t1").await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn cancel_turn_not_found_404() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.cancel_queued_turn("s1", "t1").await.unwrap_err();
    assert!(matches!(err, ChatRouteError::TurnNotFound(_)));
}

// ---------------------------------------------------------------------------
// POST .../chat/queue/:turnId/edit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn edit_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.edit_queued_turn("nope", "t1").await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn edit_turn_not_queued_404() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.edit_queued_turn("s1", "t1").await.unwrap_err();
    assert!(matches!(err, ChatRouteError::TurnNotQueued(_)));
}

// ---------------------------------------------------------------------------
// POST .../chat/queue/:turnId/resubmit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn resubmit_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r
        .resubmit_queued_turn(
            "nope",
            "t1",
            ResubmitBody {
                edited: true,
                message: Some("x".into()),
                attachment_ids: None,
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn resubmit_not_editing_404() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .resubmit_queued_turn(
            "s1",
            "t1",
            ResubmitBody {
                edited: false,
                message: None,
                attachment_ids: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::NotEditing(_)));
}

// ---------------------------------------------------------------------------
// POST .../chat/queue/:turnId/promote
// ---------------------------------------------------------------------------

#[tokio::test]
async fn promote_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.promote_queued_turn("nope", "t1").await.unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn promote_turn_not_queued_404() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.promote_queued_turn("s1", "t1").await.unwrap_err();
    assert!(matches!(err, ChatRouteError::TurnNotQueued(_)));
}

// ---------------------------------------------------------------------------
// PATCH .../chat/model
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_model_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r
        .patch_chat_model("nope", PatchModelBody { model: None })
        .await
        .unwrap_err();
    assert!(not_found(&err));
}

#[tokio::test]
async fn patch_model_done_session_409() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.lifecycle.state = LifecycleState::Done;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .patch_chat_model("s1", PatchModelBody { model: None })
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::Done(_)));
}

// ---------------------------------------------------------------------------
// Live-agent paths (#[ignore]d — need a real JsonAgentSession whose drain
// loop spawns a process).
// ---------------------------------------------------------------------------

/// Set up a temp home with a modes.json so `resolve_json_agent` can resolve a
/// `claude` mode. Returns the guard that must stay alive.
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

#[tokio::test]
#[ignore = "spawns a real claude process via the agent drain loop"]
async fn chat_json_returns_202_turn_id() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r
        .chat_session(
            "s1",
            ChatBody {
                message: "hello".into(),
                attachment_ids: None,
                queue: Some(true),
            },
        )
        .await
        .unwrap();
    assert!(!res.turn_id.is_empty());
}
