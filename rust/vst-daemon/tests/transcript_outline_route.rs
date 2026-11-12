//! Integration test for `GET /api/sessions/:id/transcript/outline` and `.../outline/window`.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
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
const SID_NOT_READY: &str = "s-not-ready";
const SID_NO_OUTLINE: &str = "s-no-outline";

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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, ct, v)
}

fn keys_of(v: &Value) -> BTreeSet<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
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

/// A Rich Chat transcript written straight to disk (no live session), with an
/// optional pre-existing `turn_outline` table to shape the index's outcome.
fn write_disk_transcript(db_path: &Path, sid: &str, turn_outline_ddl: Option<&str>) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
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
    if let Some(ddl) = turn_outline_ddl {
        conn.execute_batch(ddl).unwrap();
    }
    let payload1 = serde_json::json!({
        "id": "e-d1",
        "sessionId": sid,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "user",
        "text": "disk history query",
        "turnId": "turn-d1",
    })
    .to_string();
    let payload2 = serde_json::json!({
        "id": "e-d2",
        "sessionId": sid,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "text",
        "text": "disk assistant refresh answer",
        "turnId": "turn-d1",
    })
    .to_string();
    conn.execute(
        "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, 0, '2026-01-01T00:00:00Z', 'user', 'turn-d1', ?2)",
        params![sid, payload1],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, 1, '2026-01-01T00:00:00Z', 'text', 'turn-d1', ?2)",
        params![sid, payload2],
    )
    .unwrap();
}

#[tokio::test]
async fn transcript_outline_route() {
    let tmp = tempdir().unwrap();
    let _home = vst_agents::home::with_home(tmp.path().to_path_buf());
    let paths = Paths::with_home(tmp.path().join(".vibe-station"));

    let store = StoreHandle::open(tmp.path().join("vibe-station.db")).unwrap();
    let live_rec = session_record(SID_LIVE, Some(Channel::Json), false);
    let disk_rec = session_record(SID_DISK, Some(Channel::Json), false);
    let tmux_rec = session_record(SID_TMUX, Some(Channel::Tmux), true);
    let not_ready_rec = session_record(SID_NOT_READY, Some(Channel::Json), false);
    let no_outline_rec = session_record(SID_NO_OUTLINE, Some(Channel::Json), false);

    store
        .add_project(project(vec![
            live_rec.clone(),
            disk_rec.clone(),
            tmux_rec.clone(),
            not_ready_rec.clone(),
            no_outline_rec.clone(),
        ]))
        .await
        .unwrap();

    let broadcaster = Broadcaster::new(64);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());

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

    live_session.persist_event_for_test(&user_ev(SID_LIVE, "Please refresh token", "turn-1"));
    live_session.persist_event_for_test(&text_ev(
        SID_LIVE,
        "I will perform a refresh of your credentials now.",
        "turn-1",
    ));
    live_session.persist_event_for_test(&user_ev(SID_LIVE, "What about turn two?", "turn-2"));
    live_session.persist_event_for_test(&text_ev(SID_LIVE, "Turn two is ready.", "turn-2"));

    let disk_data_dir = paths.direct_session_data_dir(PID, SID_DISK);
    std::fs::create_dir_all(&disk_data_dir).unwrap();
    write_disk_transcript(&disk_data_dir.join("messages.db"), SID_DISK, None);

    // A pre-existing index table with a column the writer cannot fill: catch-up fails,
    // so the index never becomes ready.
    let not_ready_dir = paths.direct_session_data_dir(PID, SID_NOT_READY);
    std::fs::create_dir_all(&not_ready_dir).unwrap();
    write_disk_transcript(
        &not_ready_dir.join("messages.db"),
        SID_NOT_READY,
        Some(
            "CREATE TABLE turn_outline (
               session_id TEXT NOT NULL, ord INTEGER NOT NULL, seq INTEGER NOT NULL,
               turn_key TEXT NOT NULL, label TEXT NOT NULL, ts TEXT,
               tools INTEGER NOT NULL, edits INTEGER NOT NULL, errors INTEGER NOT NULL,
               extra TEXT NOT NULL,
               PRIMARY KEY (session_id, ord), UNIQUE (session_id, turn_key)
             );",
        ),
    );

    // A pre-existing index table without `seq`: the schema cannot be created, so the
    // outline is unavailable for this session.
    let no_outline_dir = paths.direct_session_data_dir(PID, SID_NO_OUTLINE);
    std::fs::create_dir_all(&no_outline_dir).unwrap();
    write_disk_transcript(
        &no_outline_dir.join("messages.db"),
        SID_NO_OUTLINE,
        Some(
            "CREATE TABLE turn_outline (
               session_id TEXT NOT NULL, ord INTEGER NOT NULL,
               turn_key TEXT NOT NULL, PRIMARY KEY (session_id, ord)
             );",
        ),
    );

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

    let summary_uri = format!("/api/sessions/{SID_LIVE}/transcript/outline");
    let window_uri = format!("/api/sessions/{SID_LIVE}/transcript/outline/window");

    // Summary: 200 JSON with exactly the camelCase keys, ETag and no-store headers.
    let etag;
    {
        let resp = app.clone().oneshot(get(&summary_uri)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(ct.starts_with("application/json"), "{ct}");
        etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .expect("etag header on a ready summary")
            .to_string();
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        let (_, _, body) = json_of(resp).await;
        assert_eq!(
            keys_of(&body),
            BTreeSet::from([
                "bucketSize",
                "edits",
                "errors",
                "ready",
                "revision",
                "tools",
                "totalTurns",
            ])
        );
        assert_eq!(body["ready"], true);
        assert_eq!(body["totalTurns"], 2);
        assert_eq!(body["bucketSize"], 1);
        assert_eq!(body["tools"], serde_json::json!([0, 0]));
        assert_eq!(body["revision"], "0");
    }

    // Summary: a matching If-None-Match answers 304 with an empty body.
    {
        let req = Request::builder()
            .uri(&summary_uri)
            .header("if-none-match", etag.as_str())
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(bytes.is_empty());
    }

    // Window: turns by index with the camelCase turn shape.
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("{window_uri}?from=0&limit=1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            keys_of(&body),
            BTreeSet::from(["from", "ready", "revision", "totalTurns", "turns"])
        );
        assert_eq!(body["ready"], true);
        assert_eq!(body["from"], 0);
        let turns = body["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(
            keys_of(&turns[0]),
            BTreeSet::from(["counts", "label", "seq", "turnKey", "ts"])
        );
        assert_eq!(turns[0]["turnKey"], "turn-1");
        assert_eq!(turns[0]["label"], "Please refresh token");
        assert_eq!(
            keys_of(&turns[0]["counts"]),
            BTreeSet::from(["edits", "errors", "tools"])
        );

        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("{window_uri}?from=1")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["turns"][0]["turnKey"], "turn-2");
        assert_eq!(body["turns"].as_array().unwrap().len(), 1);

        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("{window_uri}?from=2")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(body["turns"].as_array().unwrap().is_empty());
    }

    // Invalid query parameters are 400 INVALID_QUERY on the window.
    for q in [
        "",
        "from=abc",
        "from=-1",
        "from=0&limit=0",
        "from=0&limit=101",
        "from=0&limit=abc",
    ] {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("{window_uri}?{q}")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{q}");
        assert_eq!(body["code"], "INVALID_QUERY", "{q}");
    }

    // A tmux session is NOT_JSON; an unknown session is NOT_FOUND (both endpoints).
    for uri in [
        format!("/api/sessions/{SID_TMUX}/transcript/outline"),
        format!("/api/sessions/{SID_TMUX}/transcript/outline/window?from=0"),
    ] {
        let (st, _, body) = json_of(app.clone().oneshot(get(&uri)).await.unwrap()).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body["code"], "NOT_JSON", "{uri}");
    }
    for uri in [
        "/api/sessions/nope/transcript/outline".to_string(),
        "/api/sessions/nope/transcript/outline/window?from=0".to_string(),
    ] {
        let (st, _, body) = json_of(app.clone().oneshot(get(&uri)).await.unwrap()).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body["code"], "NOT_FOUND", "{uri}");
    }

    // A session that exists only on disk is served from its store.
    {
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!("/api/sessions/{SID_DISK}/transcript/outline")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["totalTurns"], 1);
        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_DISK}/transcript/outline/window?from=0"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["turns"][0]["turnKey"], "turn-d1");
    }

    // An index that cannot catch up answers not ready: no ETag, no turns, still 200.
    {
        let resp = app
            .clone()
            .oneshot(get(&format!(
                "/api/sessions/{SID_NOT_READY}/transcript/outline"
            )))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            resp.headers().get("etag").is_none(),
            "no ETag while not ready"
        );
        let (_, _, body) = json_of(resp).await;
        assert_eq!(body["ready"], false);
        assert_eq!(body["totalTurns"], 0);
        assert_eq!(body["revision"], "0");

        let (st, _, body) = json_of(
            app.clone()
                .oneshot(get(&format!(
                    "/api/sessions/{SID_NOT_READY}/transcript/outline/window?from=0"
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["ready"], false);
        assert!(body["turns"].as_array().unwrap().is_empty());
    }

    // An outline whose schema cannot be created is 503 OUTLINE_UNAVAILABLE on both endpoints.
    for uri in [
        format!("/api/sessions/{SID_NO_OUTLINE}/transcript/outline"),
        format!("/api/sessions/{SID_NO_OUTLINE}/transcript/outline/window?from=0"),
    ] {
        let (st, _, body) = json_of(app.clone().oneshot(get(&uri)).await.unwrap()).await;
        assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(body["code"], "OUTLINE_UNAVAILABLE", "{uri}");
    }
}
