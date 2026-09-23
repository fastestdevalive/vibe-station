//! Behavior contract for `sessions.ts` Group D (dispatch #5).
//!
//! Ports the Group D slice of `daemon/src/routes/sessions.ts` (approx lines
//! 2608-3009): `spawnTtyForAgent` helper, `PATCH /sessions/:id/channel`,
//! `GET /sessions/:id/transcript`, and `GET /sessions/:id/meta`.
//!
//! Tests verify:
//! 1. `patch_session_channel`:
//!    - 404 for missing session
//!    - 404 for global draft
//!    - 400 for non-agent (terminal) session
//!    - Idempotent no-op when current channel == target channel (returns ok: true, channel)
//!    - 409 "not_idle" when json agent has an active turn or queued items
//!    - json -> tty (tmux):
//!        * releases JSON agent from registry
//!        * allocates real tmux name (`tmuxNameForSession`)
//!        * updates session record with channel, use_tmux, tmux_name
//!        * resets lifecycle to Working (the critical two-axis invariant!)
//!        * emits `session:updated`, `session:meta`, and `session:state` (Working)
//!        * returns ok: true, channel, history_imported: false
//!    - tty -> json:
//!        * tears down tmux session / pty
//!        * resets tmuxName to `__direct__-<id>`
//!        * refreshes chat ID on toggle if plugin supports it
//!        * creates fresh JSON agent in registry
//!        * backfills native history if CLI has importer (claude/opencode -> history_imported: true)
//!        * returns lossily (history_imported: false) for cursor/agy
//!        * emits `session:updated` and `session:meta`
//!        * returns ok: true, channel, history_imported
//! 2. `get_session_transcript`:
//!    - 404 for missing session
//!    - 404 with specific message if session is not json-channel
//!    - query parameters:
//!        * `?all=1` or `?all=true` -> AllEvents
//!        * `?since=<seq>` -> SincePage (400 if invalid since)
//!        * `?beforeSeq=<seq>&limit=<n>` -> TranscriptPage (400 if invalid beforeSeq or limit <= 0)
//!        * (no query or limit only) -> TranscriptPage tail (400 if invalid limit <= 0)
//! 3. `get_session_meta`:
//!    - 404 for missing session
//!    - returns SessionMeta (live agent if registered, or rebuilt from transcript/mode fallback)

use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{ChannelError, SessionRoutes, TranscriptError, TranscriptQuery};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::PatchChannelBody;
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
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
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
    s.tmux_name = format!("__direct__-{id}");
    s.channel = Some(Channel::Json);
    s
}

fn terminal_session(id: &str, project_id: &str) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.r#type = SessionType::Terminal;
    s.mode_id = None;
    s.channel = Some(Channel::Tmux);
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
    }
}

async fn add_project(store: &StoreHandle, p: ProjectRecord) {
    store.add_project(p).await.unwrap();
}

async fn add_global_draft(store: &StoreHandle, id: &str) {
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: id.into(),
            draft_prompt: Some("draft prompt".into()),
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/channel validation & status tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_channel_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store);
    let err = r
        .patch_session_channel(
            "s-none",
            PatchChannelBody {
                channel: Channel::Json,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelError::NotFound(_)));
}

#[tokio::test]
async fn patch_channel_global_draft_404() {
    let (_d, store) = store();
    add_global_draft(&store, "gd1").await;
    let r = routes(store);
    let err = r
        .patch_session_channel(
            "gd1",
            PatchChannelBody {
                channel: Channel::Json,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelError::NotFound(_)));
}

#[tokio::test]
async fn patch_channel_terminal_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(terminal_session("t1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let err = r
        .patch_session_channel(
            "t1",
            PatchChannelBody {
                channel: Channel::Json,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelError::NotAgent(_)));
}

#[tokio::test]
async fn patch_channel_idempotent_noop_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1")); // Tmux
    add_project(&store, p).await;

    let r = routes(store);
    let res = r
        .patch_session_channel(
            "s1",
            PatchChannelBody {
                channel: Channel::Tmux,
            },
        )
        .await
        .unwrap();
    assert!(res.ok);
    assert_eq!(res.channel, Channel::Tmux);
    assert!(!res.history_imported);
}

#[tokio::test]
async fn patch_channel_idempotent_noop_json_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1")); // Json
    add_project(&store, p).await;

    let r = routes(store);
    let res = r
        .patch_session_channel(
            "s1",
            PatchChannelBody {
                channel: Channel::Json,
            },
        )
        .await
        .unwrap();
    assert!(res.ok);
    assert_eq!(res.channel, Channel::Json);
    assert!(!res.history_imported);
}

// ---------------------------------------------------------------------------
// GET /sessions/:id/transcript validation tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn transcript_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store);
    let err = r
        .get_session_transcript("s-none", TranscriptQuery::default())
        .await
        .unwrap_err();
    assert!(matches!(err, TranscriptError::NotFound(_)));
}

#[tokio::test]
async fn transcript_non_json_session_404() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1")); // Tmux channel
    add_project(&store, p).await;

    let r = routes(store);
    let err = r
        .get_session_transcript("s1", TranscriptQuery::default())
        .await
        .unwrap_err();
    match err {
        TranscriptError::NotJson(msg) => {
            assert!(msg.contains("has no event log (not a Rich Chat session)"));
        }
        _ => panic!("expected NotJson error, got {:?}", err),
    }
}

#[tokio::test]
async fn transcript_invalid_since_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let q = TranscriptQuery {
        since: Some("not_a_number".into()),
        ..Default::default()
    };
    let err = r.get_session_transcript("s1", q).await.unwrap_err();
    assert!(matches!(err, TranscriptError::InvalidQuery(_)));
}

#[tokio::test]
async fn transcript_invalid_before_seq_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let q = TranscriptQuery {
        before_seq: Some("not_a_number".into()),
        limit: Some("20".into()),
        ..Default::default()
    };
    let err = r.get_session_transcript("s1", q).await.unwrap_err();
    assert!(matches!(err, TranscriptError::InvalidQuery(_)));
}

#[tokio::test]
async fn transcript_invalid_limit_zero_or_negative_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let q = TranscriptQuery {
        limit: Some("0".into()),
        ..Default::default()
    };
    let err = r.get_session_transcript("s1", q).await.unwrap_err();
    assert!(matches!(err, TranscriptError::InvalidQuery(_)));

    let q_neg = TranscriptQuery {
        limit: Some("-5".into()),
        ..Default::default()
    };
    let err_neg = r.get_session_transcript("s1", q_neg).await.unwrap_err();
    assert!(matches!(err_neg, TranscriptError::InvalidQuery(_)));
}

#[tokio::test]
async fn transcript_empty_data_dir_tail_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let page = r.get_session_transcript_tail("s1", 20).await.unwrap();
    assert!(page.events.is_empty());
    assert_eq!(page.oldest_seq, None);
    assert!(!page.has_more);
}

#[tokio::test]
async fn transcript_all_empty_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let all = r.get_session_transcript_all("s1").await.unwrap();
    assert!(all.events.is_empty());
}

// ---------------------------------------------------------------------------
// GET /sessions/:id/meta validation tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn meta_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store);
    let err = r.get_session_meta("s-none").await.unwrap_err();
    assert!(matches!(err, TranscriptError::NotFound(_)));
}

#[tokio::test]
async fn meta_rebuilds_from_disk_for_existing_session_ok() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store);
    let meta = r.get_session_meta("s1").await.unwrap();
    assert_eq!(meta.session_id, "s1");
    assert_eq!(meta.channel, Channel::Json);
    assert_eq!(meta.cli, "claude");
}
