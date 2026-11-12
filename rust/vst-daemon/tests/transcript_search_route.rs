//! Integration tests for `GET /api/sessions/:id/transcript/search` and `aroundSeq`.
//! Tests 2.T1 - 2.T7.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

use rusqlite::params;
use vst_agents::claude::create_claude_plugin;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::{
    Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider,
    ProjectRecord, Role, SessionLifecycle, SessionRecord, SessionType,
};

static EV_COUNTER: AtomicU64 = AtomicU64::new(1);

const PID: &str = "p-1";
const SID_LIVE: &str = "s-live";
const SID_DISK: &str = "s-disk";
const SID_TMUX: &str = "s-tmux";

fn session_record(id: &str, channel: Option<Channel>, use_tmux: bool) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: PID.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux,
        channel,
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
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
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn project(sessions: Vec<SessionRecord>) -> ProjectRecord {
    ProjectRecord {
        id: PID.into(),
        absolute_path: "/repos/p1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: sessions,
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

async fn json_of(resp: axum::response::Response) -> (StatusCode, String, Value) {
    let status = resp.status();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, ct, v)
}

fn user_ev(session_id: &str, text: &str, turn_id: &str) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = format!("e-{}", EV_COUNTER.fetch_add(1, Ordering::Relaxed));
    e.session_id = session_id.into();
    e.ts = "2026-01-01T00:00:00.000Z".into();
    e.kind = NormalizedEventKind::User;
    e.role = Some(Role::User);
    e.text = Some(text.into());
    e.turn_id = Some(turn_id.into());
    e
}

fn text_ev(session_id: &str, text: &str, turn_id: &str) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = format!("e-{}", EV_COUNTER.fetch_add(1, Ordering::Relaxed));
    e.session_id = session_id.into();
    e.ts = "2026-01-01T00:00:00.000Z".into();
    e.kind = NormalizedEventKind::Text;
    e.role = Some(Role::Assistant);
    e.text = Some(text.into());
    e.turn_id = Some(turn_id.into());
    e
}

#[tokio::test]
async fn transcript_search_and_around_routes() {
    let tmp = tempdir().unwrap();
    let _home = vst_agents::home::with_home(tmp.path().to_path_buf());
    let paths = Paths::with_home(tmp.path().join(".vibe-station"));

    let store = StoreHandle::open(tmp.path().join("vibe-station.db")).unwrap();
    let live_rec = session_record(SID_LIVE, Some(Channel::Json), false);
    let disk_rec = session_record(SID_DISK, Some(Channel::Json), false);
    let tmux_rec = session_record(SID_TMUX, Some(Channel::Tmux), true);

    store
        .add_project(project(vec![
            live_rec.clone(),
            disk_rec.clone(),
            tmux_rec.clone(),
        ]))
        .await
        .unwrap();

    let broadcaster = Broadcaster::new(64);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());

    // Create live session in registry
    let live_session = Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project: project(vec![live_rec.clone()]),
        worktree: None,
        session: live_rec,
        plugin: Arc::new(create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: broadcaster.clone(),
    }));
    json_registry.set(SID_LIVE.to_string(), live_session.clone());

    // Append some turns to live session
    live_session.persist_event_for_test(&user_ev(SID_LIVE, "Please refresh token", "turn-1"));
    live_session.persist_event_for_test(&text_ev(
        SID_LIVE,
        "I will perform a refresh of your credentials now.",
        "turn-1",
    ));
    live_session.persist_event_for_test(&user_ev(SID_LIVE, "What about turn two?", "turn-2"));
    live_session.persist_event_for_test(&text_ev(SID_LIVE, "Turn two is ready.", "turn-2"));

    // Also populate a non-live session directly on disk with raw SQL (no FTS tables)
    let disk_data_dir = paths.direct_session_data_dir(PID, SID_DISK);
    std::fs::create_dir_all(&disk_data_dir).unwrap();
    let db_path = disk_data_dir.join("messages.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE message (
               session_id TEXT NOT NULL,
               seq INTEGER NOT NULL,
               ts TEXT,
               kind TEXT,
               turn_id TEXT,
               payload TEXT NOT NULL,
               superseded INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (session_id, seq)
            );",
        )
        .unwrap();
        let payload1 = serde_json::json!({
            "id": "e-d1",
            "sessionId": SID_DISK,
            "ts": "2026-01-01T00:00:00Z",
            "provider": "claude",
            "kind": "user",
            "text": "disk history query",
            "turnId": "turn-d1",
        })
        .to_string();
        let payload2 = serde_json::json!({
            "id": "e-d2",
            "sessionId": SID_DISK,
            "ts": "2026-01-01T00:00:00Z",
            "provider": "claude",
            "kind": "text",
            "text": "disk assistant refresh answer",
            "turnId": "turn-d1",
        })
        .to_string();
        conn.execute(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, 0, '2026-01-01T00:00:00Z', 'user', 'turn-d1', ?2)",
            params![SID_DISK, payload1],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, 1, '2026-01-01T00:00:00Z', 'text', 'turn-d1', ?2)",
            params![SID_DISK, payload2],
        )
        .unwrap();
    }

    let dist_dir = tmp.path().join("dist");
    std::fs::create_dir_all(&dist_dir).unwrap();
    std::fs::write(dist_dir.join("index.html"), "<html><body>SPA</body></html>").unwrap();

    let app = build_app(BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: Some(dist_dir),
        persist_epoch: None,
        store: store.clone(),
        broadcaster: broadcaster.clone(),
        json_registry: json_registry.clone(),
        tmux: vst_proc::test_support::isolated_tmux(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: paths.clone(),
        limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".to_string()),
        update: vst_daemon::update::UpdateService::for_tests(paths.vst_home()),
    });

    // 2.T1 Integration: GET /api/sessions/s-live/transcript/search?q=refresh -> 200 with exact camelCase contract keys
    {
        let (st, ct, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript/search?q=refresh&snippets=1"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(ct.contains("application/json"), "{ct}");
        assert_eq!(body["query"], "refresh");
        assert_eq!(body["total"], 2);
        assert_eq!(body["totalCapped"], false);
        assert_eq!(body["backfilling"], false);
        assert_eq!(body["turnCount"], 2);
        assert_eq!(body["indexedThroughSeq"], 3);
        assert!(body.get("nextCursor").is_none());
        let matches = body["matches"].as_array().expect("matches array");
        assert_eq!(matches.len(), 2);
        assert!(matches[0]["seq"].is_number());
        assert!(matches[0]["turnIndex"].is_number());
        assert!(matches[0]["kind"].is_string());
        assert!(matches[0]["occurrence"].is_number());
        let segs = matches[0]["snippet"].as_array().expect("snippet segments");
        assert!(!segs.is_empty());
        assert!(segs[0]["text"].is_string());
        assert!(segs.iter().any(|s| s["hit"] == true));
    }

    // 2.T2 Integration: q=, q=ab, q=%00abc, 201-char q, limit=0, limit=1001, scope=x, after=12, snippets=2 -> 400 QUERY_INVALID
    for invalid_uri in [
        format!("/api/sessions/{SID_LIVE}/transcript/search?q="),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=ab"),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=%00abc"),
        format!(
            "/api/sessions/{SID_LIVE}/transcript/search?q={}",
            "a".repeat(201)
        ),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=refresh&limit=0"),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=refresh&limit=1001"),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=refresh&scope=x"),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=refresh&after=12"),
        format!("/api/sessions/{SID_LIVE}/transcript/search?q=refresh&snippets=2"),
    ] {
        let (st, _, body) = json_of(app.clone().oneshot(get(&invalid_uri)).await.unwrap()).await;
        assert_eq!(
            st,
            StatusCode::BAD_REQUEST,
            "expected 400 for {invalid_uri}, got {st}: {body}"
        );
        assert_eq!(
            body["code"], "QUERY_INVALID",
            "expected code QUERY_INVALID for {invalid_uri}, got: {body}"
        );
    }

    // 2.T3 Integration: unknown session -> 404 NOT_FOUND; tmux-channel session -> 404 NOT_JSON
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get("/api/sessions/s-unknown/transcript/search?q=refresh"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "NOT_FOUND");
    }
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_TMUX}/transcript/search?q=refresh"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "NOT_JSON");
    }

    // 2.T4 Integration: a non-live session (record + messages.db on disk, not in registry) is searchable and gets backfilled
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_DISK}/transcript/search?q=refresh"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["total"], 1);
        assert_eq!(body["backfilling"], false);
    }

    // 2.T5 Integration: around mode
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript?aroundSeq=2&limit=1"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let events = body["events"].as_array().expect("events array");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["logSeq"], 2);
        assert_eq!(events[1]["logSeq"], 3);
        assert_eq!(body["hasMore"], true);
        assert_eq!(body["turnsBefore"], 1);
        assert_eq!(body["oldestSeq"], 2);
    }
    // limit=0 -> 400 INVALID_QUERY
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript?aroundSeq=2&limit=0"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "INVALID_QUERY");
    }
    // limit=51 -> 400 INVALID_QUERY
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript?aroundSeq=2&limit=51"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "INVALID_QUERY");
    }
    // aroundSeq=x -> 400 INVALID_QUERY
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript?aroundSeq=x"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "INVALID_QUERY");
    }
    // s-unknown around -> 404 NOT_FOUND
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get("/api/sessions/s-unknown/transcript?aroundSeq=0"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "NOT_FOUND");
    }
    // s-tmux around -> 404 NOT_JSON
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_TMUX}/transcript?aroundSeq=0"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "NOT_JSON");
    }

    // 2.T6 Integration: the unprefixed path /sessions/s-live/transcript/search?q=refresh does not return the JSON page
    {
        let (st, ct, _) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/sessions/{SID_LIVE}/transcript/search?q=refresh"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_ne!(ct, "application/json");
        assert_eq!(st, StatusCode::OK); // SPA fallback serves index.html
    }

    // 2.T7 Regression: GET /api/sessions/s-live/transcript?beforeSeq=... and tail mode return turnsBefore
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("/api/sessions/{SID_LIVE}/transcript")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["turnsBefore"], 0,
            "tail mode should return turnsBefore == 0: {body}"
        );
    }
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_LIVE}/transcript?beforeSeq=999&limit=5"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["turnsBefore"], 0,
            "beforeSeq mode should return turnsBefore == 0: {body}"
        );
    }
}
