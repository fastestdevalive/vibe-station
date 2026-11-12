//! HTTP-level tests for the Rich Chat side of review comments (plan 04, Phase 2):
//! the chat route's refusal bodies and "Restore to comments" on a sent card.
//!
//! Real sqlite store, real router driven with `oneshot`; no TCP port is bound.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, BuildServerOptions};
use vst_git::paths::Paths;
use vst_store::transcript::open_transcript_store;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::review::{ReviewCommentSnapshot, ReviewRecord};
use vst_types::{
    Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider,
    ProjectRecord, Role, SessionLifecycle, SessionRecord, SessionType,
};

const ISO: &str = "2026-01-01T00:00:00.000Z";

fn json_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: false,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: ISO.into(),
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

struct H {
    _tmp: TempDir,
    _home: vst_agents::home::HomeGuard,
    router: Router,
}

impl H {
    async fn new() -> H {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let vst_home = home.join(".vibe-station");
        let guard = vst_agents::home::with_home(home);
        let proj = tmp.path().join("proj1");
        std::fs::create_dir_all(&proj).unwrap();
        let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
        store
            .add_project(ProjectRecord {
                id: "p1".into(),
                absolute_path: proj.to_string_lossy().to_string(),
                prefix: "vs".into(),
                is_git: false,
                default_branch: None,
                created_at: ISO.into(),
                hidden: None,
                direct_sessions: vec![json_session("sd1")],
                direct_session_seq: Some(1),
                worktrees: vec![],
                next_worktree_num: Some(2),
                lsp_enabled: None,
                open_files: vec![],
            })
            .await
            .unwrap();
        let state = build_state(BuildServerOptions {
            network: NetworkControl::fixed(false),
            port: 0,
            auth_state: None,
            no_auth: true,
            stop_requested: Arc::new(tokio::sync::Notify::new()),
            dist_path: None,
            persist_epoch: None,
            store,
            broadcaster: Broadcaster::new(1024),
            json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::<
                vst_agents::json_agent_session::JsonAgentSession,
            >::new()),
            tmux: vst_proc::test_support::isolated_tmux(),
            started_at: Instant::now(),
            version: "test".into(),
            paths: Paths::with_home(vst_home),
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });
        H {
            _tmp: tmp,
            _home: guard,
            router: router_from_state(state),
        }
    }

    async fn json(&self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().uri(uri).method(method);
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let resp = self
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn create_body(id: &str, line: u32) -> Value {
    json!({
        "id": id, "path": "src/a.rs", "pathKind": "repo", "surface": "file",
        "lineStart": line, "lineEnd": line,
        "quote": format!("quote of {id}"), "prefix": "", "suffix": "",
        "occurrence": 0, "text": format!("text of {id}")
    })
}

const COMMENTS: &str = "/api/projects/p1/comments";

#[tokio::test]
async fn chat_refusals_carry_their_status_code_and_detail() {
    let h = H::new().await;
    for (id, line) in [("a", 1), ("b", 2)] {
        let (st, v) = h
            .json(Method::POST, COMMENTS, Some(create_body(id, line)))
            .await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
    }

    // Unknown ids: 409 comments_changed with the number that still exist.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/sd1/chat",
            Some(json!({ "message": "", "reviewCommentIds": ["a", "gone"] })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    // `error` is the stable code (what the UI switches on); `message` is the text.
    assert_eq!(v["error"], "comments_changed", "{v}");
    assert_eq!(v["code"], "comments_changed");
    assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()), "{v}");
    assert_eq!(v["remaining"], 1);

    // Scheduling with stale ids answers in the same shape.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/sd1/schedule",
            Some(json!({
                "message": "",
                "fireAt": "2099-01-01T00:00:00Z",
                "reviewCommentIds": ["a", "gone"]
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"], "comments_changed", "{v}");
    assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()), "{v}");
    assert_eq!(v["remaining"], 1);

    // Attached to another composer: 403 not_attached.
    let (st, _) = h
        .json(
            Method::POST,
            &format!("{COMMENTS}/attach"),
            Some(json!({ "composerKey": "session:other", "commentIds": ["b"] })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/sd1/chat",
            Some(json!({ "message": "x", "reviewCommentIds": ["b"] })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{v}");
    assert_eq!(v["error"], "not_attached", "{v}");
    assert_eq!(v["code"], "not_attached");

    // Nothing moved.
    let (_, list) = h.json(Method::GET, COMMENTS, None).await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 2);
}

fn snap(pin: u32, id: &str) -> ReviewCommentSnapshot {
    serde_json::from_value(json!({
        "id": id, "pin": pin, "path": "src/a.rs", "pathKind": "repo", "surface": "file",
        "quote": format!("quote of {id}"), "text": format!("text of {id}"),
        "anchor": "anchored", "lineStart": pin, "lineEnd": pin
    }))
    .unwrap()
}

fn user_row(turn: &str, cancelled: bool, review: Option<ReviewRecord>) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = format!("ev-{turn}");
    e.session_id = "sd1".into();
    e.ts = "2026-01-01T00:00:00Z".into();
    e.provider = NormalizedEventProvider::Claude;
    e.kind = NormalizedEventKind::User;
    e.role = Some(Role::User);
    e.text = Some("m".into());
    e.turn_id = Some(turn.into());
    e.cancelled = cancelled.then_some(true);
    e.review = review;
    e
}

/// 2.T10 — idempotent, reads only the persisted snapshot, 409 on a cancelled row.
#[tokio::test]
async fn restore_review_reads_the_persisted_snapshot_and_is_idempotent() {
    let h = H::new().await;
    let dir = vst_agents::paths::Paths::default().direct_session_data_dir("p1", "sd1");
    let mut store = open_transcript_store(&dir, "sd1").unwrap();
    let record = ReviewRecord {
        name: "proj1".into(),
        comments: vec![snap(1, "a"), snap(2, "b")],
    };
    store.append(&mut user_row("t-ok", false, Some(record)));
    store.append(&mut user_row("t-cancelled", true, None));
    store.append(&mut user_row("t-plain", false, None));
    store.close();

    let url = |t: &str| format!("/api/sessions/sd1/chat/turns/{t}/restore-review");
    let (st, v) = h.json(Method::POST, &url("t-ok"), None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        (v["restored"].as_u64(), v["skipped"].as_u64()),
        (Some(2), Some(0))
    );

    let (_, list) = h.json(Method::GET, COMMENTS, None).await;
    let comments = list["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 2);
    assert_eq!(
        comments
            .iter()
            .map(|c| c["pin"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2],
        "original pins"
    );
    assert!(comments.iter().all(|c| c.get("restoredReason").is_none()));

    // Again: nothing new, both skipped.
    let (st, v) = h.json(Method::POST, &url("t-ok"), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        (v["restored"].as_u64(), v["skipped"].as_u64()),
        (Some(0), Some(2))
    );
    let (_, list) = h.json(Method::GET, COMMENTS, None).await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 2);

    // Cancelled / review-less rows: 409. Unknown turn / session: 404.
    for t in ["t-cancelled", "t-plain"] {
        let (st, v) = h.json(Method::POST, &url(t), None).await;
        assert_eq!(st, StatusCode::CONFLICT, "{t}: {v}");
        assert_eq!(v["error"], "turn_not_restorable");
    }
    let (st, _) = h.json(Method::POST, &url("nope"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = h
        .json(
            Method::POST,
            "/api/sessions/ghost/chat/turns/t-ok/restore-review",
            None,
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}
