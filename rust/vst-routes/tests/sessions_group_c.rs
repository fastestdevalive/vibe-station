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

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{
    read_transcript_from_data_dir, JsonAgentSession, JsonAgentSessionOptions,
};
use vst_agents::paths::Paths as AgentPaths;
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{ChatRouteError, ResetError, SessionRoutes};
use vst_store::transcript::open_transcript_store;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::{
    ChatBody, InputBody, PatchModelBody, QueuedPolicy, ResetBody, ResubmitBody,
};
use vst_types::{
    CarryOver, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind,
    NormalizedEventProvider, ProjectRecord, Role, SessionLifecycle, SessionNameSource,
    SessionRecord, SessionType,
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
        initial_prompt: None,
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
        handoff_timeout: std::time::Duration::from_secs(120),
        reset_cancels: Default::default(),
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
async fn send_tmux_empty_no_enter_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r
        .send_session(
            "s1",
            InputBody {
                data: "".into(),
                send_enter: None,
                attachment_ids: None,
                queue: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::BadRequest(_)), "{err:?}");
}

#[tokio::test]
async fn send_tmux_empty_with_enter_skips_paste() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r
        .send_session(
            "s1",
            InputBody {
                data: "".into(),
                send_enter: Some(true),
                attachment_ids: None,
                queue: None,
            },
        )
        .await;
    if let Err(e) = res {
        assert!(!matches!(e, ChatRouteError::BadRequest(_)), "{e:?}");
        let msg = format!("{e:?}");
        assert!(
            !msg.contains("paste-buffer") && !msg.contains("no buffer"),
            "{msg}"
        );
    }
}

#[tokio::test]
async fn send_direct_pty_empty_with_enter_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(pty_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let pty = vst_proc::pty::spawn_child(vst_proc::pty::SpawnChildOptions {
        command: "/bin/cat".into(),
        args: vec![],
        cwd: std::env::temp_dir(),
        env: Default::default(),
        cols: 120,
        rows: 24,
        session_id: "s1".into(),
        project_id: "p1".into(),
        worktree_id: None,
    })
    .expect("spawn cat");
    r.direct_ptys
        .write()
        .unwrap()
        .insert("s1".into(), pty.clone());

    let res = r
        .send_session(
            "s1",
            InputBody {
                data: "".into(),
                send_enter: Some(true),
                attachment_ids: None,
                queue: None,
            },
        )
        .await;
    pty.kill();
    assert!(res.is_ok(), "{res:?}");
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
                mentions: None,
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
                mentions: None,
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
                mentions: None,
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
                mentions: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::AttachmentNotFound(_)));
}

#[tokio::test]
async fn chat_with_51_mentions_bad_request() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let mentions: Vec<_> = (0..51)
        .map(|i| vst_types::Mention {
            kind: vst_types::MentionKind::File,
            id: format!("f{i}.ts"),
            label: format!("f{i}.ts"),
        })
        .collect();
    let err = r
        .chat_session(
            "any",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
                mentions: Some(mentions),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::BadRequest(_)));
}

#[tokio::test]
async fn chat_with_control_char_label_bad_request() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let mentions = vec![vst_types::Mention {
        kind: vst_types::MentionKind::File,
        id: "a.ts".into(),
        label: "bad\nlabel".into(),
    }];
    let err = r
        .chat_session(
            "any",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
                mentions: Some(mentions),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::BadRequest(_)));
}

#[tokio::test]
async fn chat_with_valid_mention_behaves_like_without() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let mentions = vec![vst_types::Mention {
        kind: vst_types::MentionKind::File,
        id: "a.ts".into(),
        label: "a.ts".into(),
    }];
    let err = r
        .chat_session(
            "nope",
            ChatBody {
                message: "hi".into(),
                attachment_ids: None,
                queue: None,
                mentions: Some(mentions),
            },
        )
        .await
        .unwrap_err();
    assert!(not_found(&err));
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
    let err = r
        .stop_active_turn("nope", Some("turn-1"))
        .await
        .unwrap_err();
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

    let res = r
        .stop_active_turn("s1", Some("stale-turn-id"))
        .await
        .unwrap();
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

fn agent_mention(id: &str, label: &str) -> vst_types::Mention {
    vst_types::Mention {
        kind: vst_types::MentionKind::Agent,
        id: id.into(),
        label: label.into(),
    }
}

#[tokio::test]
async fn resubmit_bad_mention_label_400() {
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
                mentions: Some(vec![agent_mention("s2", "bad\nlabel")]),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::BadRequest(_)));
}

#[tokio::test]
async fn edit_and_resubmit_carry_mentions() {
    let dir = tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let plugin = Arc::from(vst_agents::resolve_plugin(vst_types::CliId::Claude));
    let session = Arc::new(vst_agents::json_agent_session::JsonAgentSession::new(
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
    ));
    r.json_registry.set("s1".to_string(), session.clone());

    let queued = session.enqueue_with(
        "orig".into(),
        vec![],
        vec![agent_mention("s2", "Agent 2")],
        None,
        None,
    );

    // edit echoes the queued record's mentions
    let edited = r.edit_queued_turn("s1", &queued.turn_id).await.unwrap();
    assert_eq!(edited.mentions, Some(vec![agent_mention("s2", "Agent 2")]));

    // an invalid resubmit is rejected and leaves the hold intact
    let err = r
        .resubmit_queued_turn(
            "s1",
            &queued.turn_id,
            ResubmitBody {
                edited: true,
                message: Some("new".into()),
                attachment_ids: None,
                mentions: Some(vec![agent_mention("s3", "bad\nlabel")]),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::BadRequest(_)));

    // a valid resubmit succeeds (hold survived the rejected one); the re-enqueued
    // turn is drained immediately so it can't be re-read from the queue
    let ok = r
        .resubmit_queued_turn(
            "s1",
            &queued.turn_id,
            ResubmitBody {
                edited: true,
                message: Some("new".into()),
                attachment_ids: None,
                mentions: Some(vec![agent_mention("s3", "Agent 3")]),
            },
        )
        .await
        .unwrap();
    assert!(ok.ok);
}

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
                mentions: None,
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
                mentions: None,
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
                mentions: None,
            },
        )
        .await
        .unwrap();
    assert!(!res.turn_id.is_empty());
}

// ---------------------------------------------------------------------------
// Skill-grammar wire text on the terminal delivery paths
// ---------------------------------------------------------------------------

/// `/send` to a direct pty flattens wire text once: text un-escaped, skill
/// tokens flattened to `/name args` (same as Rich Chat), then written to the pty.
#[tokio::test]
async fn send_direct_pty_unescapes_wire_text_once() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(pty_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let pty = vst_proc::pty::spawn_child(vst_proc::pty::SpawnChildOptions {
        command: "/bin/cat".into(),
        args: vec![],
        cwd: std::env::temp_dir(),
        env: Default::default(),
        cols: 120,
        rows: 24,
        session_id: "s1".into(),
        project_id: "p1".into(),
        worktree_id: None,
    })
    .expect("spawn cat");
    r.direct_ptys
        .write()
        .unwrap()
        .insert("s1".into(), pty.clone());

    r.send_session(
        "s1",
        InputBody {
            data: r"C:\\temp \{a} {/review a\}b}".into(),
            send_enter: None,
            attachment_ids: None,
            queue: None,
        },
    )
    .await
    .unwrap();

    let seen = pty
        .wait_for_output(
            r"C:\temp {a} /review a}b",
            std::time::Duration::from_secs(5),
        )
        .await;
    let out = pty.get_recent_output(4096);
    pty.kill();
    assert!(seen, "pty should echo the plain text once, got: {out:?}");
    assert!(
        !out.contains(r"\\temp"),
        "escaped text must not reach the pty: {out:?}"
    );
}

/// Records the `task_prompt` handed to `compose_launch_prompt` and launches
/// `/bin/cat` so `spawn_session` can complete on a direct pty.
struct ComposeRecorder {
    task_prompts: std::sync::Mutex<Vec<Option<String>>>,
}

impl vst_agents::AgentPlugin for ComposeRecorder {
    fn name(&self) -> &str {
        "recorder"
    }
    fn default_model(&self) -> &str {
        "m"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> vst_agents::plugin::PromptDelivery {
        vst_agents::plugin::PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &vst_agents::LaunchConfig) -> Vec<String> {
        vec!["/bin/cat".into()]
    }
    fn get_environment(
        &self,
        _cfg: &vst_agents::LaunchConfig,
    ) -> std::collections::BTreeMap<String, String> {
        Default::default()
    }
    fn get_ready_signal(&self) -> vst_agents::plugin::ReadySignal {
        vst_agents::plugin::ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(
        &self,
        input: vst_agents::plugin::ComposePromptInput,
    ) -> vst_agents::plugin::ComposePromptResult {
        self.task_prompts.lock().unwrap().push(input.task_prompt);
        Default::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Pty
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<vst_agents::plugin::ListModelsResult> {
        Box::pin(async { Default::default() })
    }
}

/// The terminal launch seam (`spawn_session`) hands the plugin plain text: the
/// wire-form create prompt is un-escaped and its skill tokens flattened.
#[tokio::test]
async fn spawn_session_flattens_wire_task_prompt_for_terminal_launch() {
    let home = tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    let proj_dir = tempdir().unwrap();
    let mut project = make_project("p1");
    project.absolute_path = proj_dir.path().display().to_string();
    project.is_git = false;
    let session = pty_session("s1", "p1");
    let plugin = ComposeRecorder {
        task_prompts: Default::default(),
    };
    let ptys = std::sync::RwLock::new(std::collections::HashMap::new());
    let tmux = vst_proc::tmux::Tmux::new();

    let _ = vst_routes::sessions::spawn_session(&vst_routes::sessions::SpawnSessionOpts {
        project: &project,
        worktree: None,
        session: &session,
        plugin: &plugin,
        daemon_port: 3999,
        system_prompt: "sys".into(),
        task_prompt: Some(r"C:\\temp \{a} {/review a\}b}".into()),
        model: None,
        tmux: &tmux,
        direct_ptys: &ptys,
    })
    .await;
    if let Some(h) = ptys.read().unwrap().get("s1") {
        h.kill();
    }
    assert_eq!(
        plugin.task_prompts.lock().unwrap().as_slice(),
        [Some(r"C:\temp {a} /review a}b".to_string())]
    );
}

// ---------------------------------------------------------------------------
// Phase 1 — ordered reset: stop-first, carry modes, queued carry/drop
// ---------------------------------------------------------------------------

/// Plugin whose `run_turn` only ends when the turn is cancelled; records that
/// the cancel actually reached it.
struct WaitPlugin {
    cancelled: Arc<AtomicBool>,
}

impl AgentPlugin for WaitPlugin {
    fn name(&self) -> &str {
        "wait-mock"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let flag = self.cancelled.clone();
        tokio::spawn(async move {
            cancel.cancelled().await;
            flag.store(true, Ordering::SeqCst);
            drop(tx);
        });
        rx
    }
}

/// Plugin whose `run_turn` BLOCKS before returning its stream, so the drain
/// loop never reaches its cancel `select!`. This is the "agent ignores cancel"
/// shape: the reset's bounded wait must time out (`BusyTimeout`). The gate
/// releases it after the test so the runtime can shut down.
struct BlockingTurnPlugin {
    gate: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
}

impl AgentPlugin for BlockingTurnPlugin {
    fn name(&self) -> &str {
        "blocking-mock"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        // Block the FIRST turn only; later turns return a closed stream at once.
        if let Some(gate) = self.gate.lock().unwrap().take() {
            let _ = gate.recv();
        }
        let (_tx, rx) = mpsc::unbounded_channel();
        rx
    }
}

/// Plugin that finishes every turn almost immediately, counting completions.
struct FastPlugin {
    turns: Arc<AtomicUsize>,
}

impl AgentPlugin for FastPlugin {
    fn name(&self) -> &str {
        "fast-mock"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let turns = self.turns.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let mut ev = NormalizedEvent::default();
            ev.kind = NormalizedEventKind::Result;
            let _ = tx.send(ev);
            turns.fetch_add(1, Ordering::SeqCst);
        });
        rx
    }
}

/// Seed the old session's transcript with one user turn so `transcript` carry
/// has something to copy.
fn seed_old_transcript(project_id: &str, session_id: &str) {
    let dir = AgentPaths::default().direct_session_data_dir(project_id, session_id);
    let mut s = open_transcript_store(&dir, session_id);
    let mut e = NormalizedEvent::default();
    e.id = "seed-user".into();
    e.session_id = session_id.into();
    e.ts = "2026-01-01T00:00:00Z".into();
    e.provider = NormalizedEventProvider::Claude;
    e.kind = NormalizedEventKind::User;
    e.role = Some(Role::User);
    e.text = Some("hello".into());
    e.turn_id = Some("t1".into());
    s.append(&mut e);
    s.close();
}

fn old_agent(
    store: &StoreHandle,
    plugin: Arc<dyn AgentPlugin>,
    session_id: &str,
) -> Arc<JsonAgentSession> {
    Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project: make_project("p1"),
        worktree: None,
        session: json_session(session_id, "p1"),
        plugin,
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: Some("my-mode".into()),
        mode_name: Some("My Mode".into()),
        store_handle: store.clone(),
        broadcaster: Broadcaster(tokio::sync::broadcast::channel(64).0),
    }))
}

fn new_agent(
    store: &StoreHandle,
    plugin: Arc<dyn AgentPlugin>,
    session_id: &str,
) -> Arc<JsonAgentSession> {
    Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project: make_project("p1"),
        worktree: None,
        session: json_session(session_id, "p1"),
        plugin,
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: Some("my-mode".into()),
        mode_name: Some("My Mode".into()),
        store_handle: store.clone(),
        broadcaster: Broadcaster(tokio::sync::broadcast::channel(64).0),
    }))
}

/// Start one running turn, then queue two more. Returns the queued turn ids.
async fn seed_busy_agent(agent: &JsonAgentSession) -> (String, String) {
    agent.enqueue("active turn".into(), vec![], None, None);
    for _ in 0..200 {
        if agent.get_meta().active_turn_id.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        agent.get_meta().active_turn_id.is_some(),
        "active turn must start"
    );
    let a = agent
        .enqueue("queued one".into(), vec![], None, None)
        .turn_id;
    let b = agent
        .enqueue("queued two".into(), vec![], None, None)
        .turn_id;
    (a, b)
}

fn user_texts(project_id: &str, session_id: &str) -> Vec<String> {
    let dir = AgentPaths::default().direct_session_data_dir(project_id, session_id);
    read_transcript_from_data_dir(&dir, session_id)
        .into_iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .filter_map(|e| e.text)
        .collect()
}

async fn wait_for_turns(agent: &JsonAgentSession, turns: &AtomicUsize, want: usize) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while turns.load(Ordering::SeqCst) < want && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(turns.load(Ordering::SeqCst), want, "all turns must run");
    // Let the drain loop finish its final persist before reading.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), agent.settled()).await;
}

/// (a) + (d): stop-first cancels the running turn, withdraws the queued turns
/// (so they do not become struck-through carried rows), and the fresh queued
/// messages are enqueued once, in order, after the instruction turn.
#[tokio::test]
async fn reset_stop_first_withdraws_queued_and_carries_them_once() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;
    seed_old_transcript("p1", "s1");

    let cancelled = Arc::new(AtomicBool::new(false));
    let old = old_agent(
        &store,
        Arc::new(WaitPlugin {
            cancelled: cancelled.clone(),
        }),
        "s1",
    );
    let (a_id, b_id) = seed_busy_agent(&old).await;

    let r = routes(store.clone());
    r.json_registry.set("s1".to_string(), old.clone());

    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..Default::default()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Transcript);
    assert!(
        cancelled.load(Ordering::SeqCst),
        "stop-first cancelled the turn"
    );
    assert!(
        r.json_registry.get("s1").is_none(),
        "the old runtime was released"
    );

    // Register a fast agent for the replacement BEFORE the detached spawn task
    // runs (current-thread runtime: no await between the reset returning and
    // this registration), so the carried messages are enqueued on it.
    let turns = Arc::new(AtomicUsize::new(0));
    let fresh = new_agent(
        &store,
        Arc::new(FastPlugin {
            turns: turns.clone(),
        }),
        &res.new_session_id,
    );
    r.json_registry
        .set(res.new_session_id.clone(), fresh.clone());
    wait_for_turns(&fresh, &turns, 3).await;

    let texts = user_texts("p1", &res.new_session_id);
    let idx_instruction = texts
        .iter()
        .position(|t| t.contains("previous-chat.md"))
        .expect("instruction turn");
    let idx_a = texts
        .iter()
        .position(|t| t == "queued one")
        .expect("queued one");
    let idx_b = texts
        .iter()
        .position(|t| t == "queued two")
        .expect("queued two");
    assert!(
        idx_instruction < idx_a && idx_a < idx_b,
        "instruction then queued one then queued two, got {texts:?}"
    );

    // Withdrawn ids are absent from the carried rows (no struck-through
    // duplicates); each queued message appears exactly once, uncancelled.
    let dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let events = read_transcript_from_data_dir(&dir, &res.new_session_id);
    assert!(
        events.iter().all(|e| e.cancelled != Some(true)),
        "no cancelled rows carried"
    );
    for id in [&a_id, &b_id] {
        assert!(
            events
                .iter()
                .all(|e| e.turn_id.as_deref() != Some(id.as_str())),
            "withdrawn turn {id} must not be carried"
        );
    }
    assert_eq!(texts.iter().filter(|t| *t == "queued one").count(), 1);
    assert_eq!(texts.iter().filter(|t| *t == "queued two").count(), 1);

    // The instruction reached the agent but is a SILENT row (it lives behind
    // the break card's toggle); the user's queued messages stay visible.
    let rows: Vec<_> = read_transcript_from_data_dir(&dir, &res.new_session_id)
        .into_iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .collect();
    let instr = rows
        .iter()
        .find(|e| {
            e.text
                .as_deref()
                .is_some_and(|t| t.contains("previous-chat.md"))
        })
        .expect("instruction row");
    assert_eq!(instr.silent, Some(true));
    assert!(rows
        .iter()
        .filter(|e| matches!(e.text.as_deref(), Some("queued one" | "queued two")))
        .all(|e| e.silent != Some(true)));
}

/// (b) + (e, failure): an agent that ignores cancellation makes the reset fail
/// with `BusyTimeout`; only the ids THIS reset moved are resubmitted, and a
/// turn the user was already editing stays held. `queued=drop` still restores
/// the withdrawn turns on failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reset_busy_timeout_restores_only_moved_turns_and_keeps_pre_held() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;
    seed_old_transcript("p1", "s1");

    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    let old = old_agent(
        &store,
        Arc::new(BlockingTurnPlugin {
            gate: Arc::new(Mutex::new(Some(gate_rx))),
        }),
        "s1",
    );
    let (a_id, b_id) = seed_busy_agent(&old).await;
    // A turn the user was already editing before the reset.
    let held_id = old
        .enqueue("held message".into(), vec![], None, None)
        .turn_id;
    assert!(old.begin_edit_queued_turn(&held_id).is_some());

    let r = routes(store.clone());
    r.json_registry.set("s1".to_string(), old.clone());

    let body = ResetBody {
        queued: Some(QueuedPolicy::Drop),
        ..Default::default()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    // Release the blocked turn before asserting / shutting the runtime down.
    let _ = gate_tx.send(());
    assert!(
        matches!(err, ResetError::BusyTimeout(_)),
        "expected BusyTimeout, got {err:?}"
    );

    let meta = old.get_meta();
    assert_eq!(
        meta.editing_turn_ids,
        vec![held_id],
        "only the pre-held turn stays held"
    );
    assert!(
        meta.queued_turn_ids.contains(&a_id) && meta.queued_turn_ids.contains(&b_id),
        "the ids this reset moved were resubmitted: {:?}",
        meta.queued_turn_ids
    );
    let project = store.get_project("p1").await.unwrap();
    let s1 = project
        .direct_sessions
        .iter()
        .find(|s| s.id == "s1")
        .unwrap();
    assert!(s1.archived_at.is_none(), "the old session stays live");
    assert!(
        r.reset_cancels.get("s1").is_none(),
        "the reset flag is removed on failure"
    );
}

/// (e, success): `queued=drop` withdraws the queued turns but never enqueues
/// them on the replacement.
#[tokio::test]
async fn reset_queued_drop_success_does_not_enqueue() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;
    seed_old_transcript("p1", "s1");

    let cancelled = Arc::new(AtomicBool::new(false));
    let old = old_agent(
        &store,
        Arc::new(WaitPlugin {
            cancelled: cancelled.clone(),
        }),
        "s1",
    );
    seed_busy_agent(&old).await;

    let r = routes(store.clone());
    r.json_registry.set("s1".to_string(), old);

    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        queued: Some(QueuedPolicy::Drop),
        ..Default::default()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert!(cancelled.load(Ordering::SeqCst));

    let turns = Arc::new(AtomicUsize::new(0));
    let fresh = new_agent(
        &store,
        Arc::new(FastPlugin {
            turns: turns.clone(),
        }),
        &res.new_session_id,
    );
    r.json_registry
        .set(res.new_session_id.clone(), fresh.clone());
    wait_for_turns(&fresh, &turns, 1).await;

    let texts = user_texts("p1", &res.new_session_id);
    assert!(
        texts.iter().any(|t| t.contains("previous-chat.md")),
        "instruction turn ran: {texts:?}"
    );
    assert!(
        !texts.iter().any(|t| t == "queued one" || t == "queued two"),
        "dropped queued messages must not be enqueued: {texts:?}"
    );
}
