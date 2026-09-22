//! HTTP-level regression test for `POST /api/sessions/:id/attachments`.
//!
//! The web-ui client (`web-ui/src/api/client.ts`'s `uploadAttachments`) sends
//! a real `multipart/form-data` request (browser `FormData`, field name
//! `files`, no explicit Content-Type so the browser sets the boundary). A
//! prior port of this handler expected `Json<Vec<UploadPartRaw>>` instead,
//! which made axum's `Json` extractor reject every real upload with a 415
//! before the handler body ever ran — see
//! `.vibekit/reports/2026-09-22-attachment-upload-debug.md` for the full
//! root-cause writeup. This test posts the actual wire shape the browser
//! sends (not the old JSON+base64 shape) and asserts it is accepted.
//!
//! Drives the router fully in-process via `build_app` + `tower::ServiceExt`
//! (no port bound), matching the pattern in `tests/parity_harness.rs` and
//! `tests/auth_middleware.rs`.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::domain::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_types::events::Broadcaster;

fn make_opts(tmp: &std::path::Path, store: StoreHandle) -> BuildServerOptions {
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        port: 0,
        auth_state: None,
        no_auth: true,
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster,
        json_registry,
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths,
    }
}

fn agent_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: Some("wt-1".into()),
        project_id: "p-1".into(),
        is_main: true,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("mode-1".into()),
        name: Some("Agent".into()),
        name_source: None,
        tmux_name: "tmux-1".into(),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00Z".into(),
        },
    }
}

async fn seed_agent_session(store: &StoreHandle, checkout: &std::path::Path, session_id: &str) {
    let session = agent_session(session_id);
    let worktree = WorktreeRecord {
        id: "wt-1".into(),
        name: None,
        branch: "main".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2026-01-01T00:00:00Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        sessions: vec![session],
    };
    let project = ProjectRecord {
        id: "p-1".into(),
        absolute_path: checkout.to_string_lossy().to_string(),
        prefix: "p1".into(),
        is_git: false,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![worktree],
        next_worktree_num: Some(2),
    };
    store.add_project(project).await.unwrap();
}

/// Build a real `multipart/form-data` request body matching the client's
/// wire contract: field name `files`, one part per file.
fn multipart_request(uri: &str, boundary: &str, filename: &str, content: &[u8]) -> Request<Body> {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\n\
             Content-Type: text/plain\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn upload_attachments_accepts_real_multipart_form_data() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let checkout = tmp.path().join("checkout");
    tokio::fs::create_dir_all(&checkout).await.unwrap();
    seed_agent_session(&store, &checkout, "s-agent-1").await;

    let router = build_app(make_opts(tmp.path(), store));

    let req = multipart_request(
        "/api/sessions/s-agent-1/attachments",
        "vstTestBoundary",
        "hello.txt",
        b"hello world",
    );

    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(status, StatusCode::OK, "body: {body}");
    let attachments = body["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["name"], "hello.txt");
    assert_eq!(attachments[0]["size"], 11);
}

#[tokio::test]
async fn upload_attachments_rejects_json_body_like_old_wire_contract() {
    // Guards against regressing back to the JSON+base64 shape: a plain JSON
    // body (the OLD, broken contract) must not be silently accepted as if it
    // were a valid multipart upload.
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let checkout = tmp.path().join("checkout");
    tokio::fs::create_dir_all(&checkout).await.unwrap();
    seed_agent_session(&store, &checkout, "s-agent-1").await;

    let router = build_app(make_opts(tmp.path(), store));

    let req = Request::builder()
        .method("POST")
        .uri("/api/sessions/s-agent-1/attachments")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"[{"filename":"hostname","content_type":"text/plain","data":"aGVsbG8="}]"#,
        ))
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();
    // Not a valid multipart body: rejected before reaching business logic,
    // and definitely not a 200 with attachments as the old JSON handler
    // would have produced.
    assert_ne!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn upload_attachments_404_for_missing_session_via_http() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let req = multipart_request(
        "/api/sessions/does-not-exist/attachments",
        "vstTestBoundary2",
        "hello.txt",
        b"hello world",
    );

    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
