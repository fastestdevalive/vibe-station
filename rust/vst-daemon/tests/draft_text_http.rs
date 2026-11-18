//! HTTP-level tests for the draft-text routes (plan 3.A.2, extended in 4.A.2):
//! the `/api` mount, the doc shape, the coded 4xx taxonomy, the push event, LWW
//! revisions across clients and the session-delete clear.
//!
//! Real sqlite store, real router driven with `oneshot`; no TCP port is bound
//! and no daemon is spawned.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

const ISO: &str = "2026-01-01T00:00:00.000Z";

fn session(id: &str, worktree: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree.map(Into::into),
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        account_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
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

fn worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("feat-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "a".repeat(40),
        created_at: ISO.into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(0),
        agent_seq: Some(1),
        lsp_enabled: None,
        sessions: vec![session("s1", Some(id))],
        open_files: vec![],
    }
}

/// Project `p1` (direct session `sd1`) with worktree `w1` (session `s1`).
struct H {
    _tmp: TempDir,
    router: Router,
    broadcaster: Broadcaster,
    store: StoreHandle,
    /// Cloned off the state before it moved into the router, so a test can
    /// start the `SessionDeleted` subscriber exactly as `run.rs` does.
    draft_text: vst_daemon::draft_text::DraftTextHandle,
}

impl H {
    async fn new() -> H {
        let tmp = tempfile::tempdir().unwrap();
        let vst_home = tmp.path().join("home").join(".vibe-station");
        let paths = Paths::with_home(vst_home);
        let proj = tmp.path().join("proj1");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(paths.worktree_path("p1", "w1")).unwrap();
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
                direct_sessions: vec![session("sd1", None)],
                direct_session_seq: Some(1),
                worktrees: vec![worktree("w1")],
                next_worktree_num: Some(2),
                lsp_enabled: None,
                open_files: vec![],
            })
            .await
            .unwrap();
        let broadcaster = Broadcaster::new(1024);
        let state = build_state(BuildServerOptions {
            network: NetworkControl::fixed(false),
            port: 0,
            auth_state: None,
            no_auth: true,
            stop_requested: Arc::new(tokio::sync::Notify::new()),
            dist_path: None,
            persist_epoch: None,
            store: store.clone(),
            broadcaster: broadcaster.clone(),
            json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::<
                vst_agents::json_agent_session::JsonAgentSession,
            >::new()),
            tmux: Tmux::with_socket("vst-dth-test"),
            started_at: Instant::now(),
            version: "test".into(),
            update: vst_daemon::update::UpdateService::for_tests(paths.vst_home()),
            paths,
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });
        let draft_text = state.draft_text.clone();
        H {
            _tmp: tmp,
            router: router_from_state(state),
            broadcaster,
            store,
            draft_text,
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

    async fn put(&self, scope: &str, text: &str, client_id: &str) -> (StatusCode, Value) {
        self.json(
            Method::PUT,
            &format!("/api/draft-texts/{scope}"),
            Some(json!({ "text": text, "clientId": client_id })),
        )
        .await
    }

    async fn get(&self, scope: &str) -> (StatusCode, Value) {
        self.json(Method::GET, &format!("/api/draft-texts/{scope}"), None)
            .await
    }

    async fn delete_session(&self, id: &str) -> (StatusCode, Value) {
        self.json(Method::DELETE, &format!("/api/sessions/{id}"), None)
            .await
    }
}

#[tokio::test]
async fn put_then_get_roundtrip() {
    let h = H::new().await;
    // `global-new` needs no existence check; the picker scope proves a
    // colon-bearing scope still routes as ONE path segment.
    for scope in ["global-new", "review-picker:worktree:w1"] {
        let (st, doc) = h.put(scope, "draft body", "client-a").await;
        assert_eq!(st, StatusCode::OK, "{scope}: {doc}");
        assert_eq!(doc["scope"], scope);
        assert_eq!(doc["text"], "draft body");
        assert_eq!(doc["revision"], 1);
        assert_eq!(doc["clientId"], "client-a");
        assert!(
            doc["updatedAt"].as_str().unwrap().ends_with('Z'),
            "ISO ms UTC: {doc}"
        );

        let (st, got) = h.get(scope).await;
        assert_eq!(st, StatusCode::OK, "{scope}: {got}");
        assert_eq!(got, doc);
    }
}

#[tokio::test]
#[allow(non_snake_case)] // named by the plan as `get_absent_returns_revision_0_updatedAt_null`
async fn get_absent_returns_revision_0_updatedAt_null() {
    let h = H::new().await;
    let (st, doc) = h.get("global-new").await;
    assert_eq!(st, StatusCode::OK, "{doc}");
    assert_eq!(
        doc,
        json!({
            "scope": "global-new", "text": "", "revision": 0,
            "updatedAt": null, "clientId": null
        })
    );
}

#[tokio::test]
async fn list_includes_tombstones() {
    let h = H::new().await;
    h.put("global-new", "tier 2 prompt", "client-a").await;
    h.put("s1", "then cleared", "client-a").await;
    let (st, cleared) = h.put("s1", "", "client-b").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(cleared["revision"], 2);

    let (st, body) = h.json(Method::GET, "/api/draft-texts", None).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let drafts = body["drafts"].as_array().expect("drafts array");
    assert_eq!(drafts.len(), 2, "both rows, tombstone included: {body}");
    let s1 = drafts
        .iter()
        .find(|d| d["scope"] == "s1")
        .expect("tombstone listed");
    assert_eq!(s1["text"], "");
    assert_eq!(s1["revision"], 2);
    assert_eq!(s1["clientId"], "client-b");
    assert_eq!(
        h.store.get_draft_text("s1").await.unwrap().unwrap().text,
        "",
        "the tombstone row is kept, not deleted"
    );
}

#[tokio::test]
async fn put_over_cap_413_code() {
    let h = H::new().await;
    let over = "a".repeat(65_537);
    let (st, body) = h.put("global-new", &over, "client-a").await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["code"], "draft_too_large");
    assert_eq!(body["limit"], 65_536);
    assert_eq!(
        h.get("global-new").await.1["revision"],
        0,
        "nothing written"
    );
}

#[tokio::test]
async fn put_65536_ok() {
    let h = H::new().await;
    let at_cap = "a".repeat(65_536);
    let (st, doc) = h.put("global-new", &at_cap, "client-a").await;
    assert_eq!(st, StatusCode::OK, "{}", doc["code"]);
    assert_eq!(doc["revision"], 1);
    assert_eq!(doc["text"].as_str().unwrap().len(), 65_536);
}

#[tokio::test]
async fn bad_scope_400() {
    let h = H::new().await;
    let body = json!({ "text": "t", "clientId": "client-a" });
    // A space (percent-encoded, still one segment) and 161 chars.
    for uri in [
        "/api/draft-texts/global%20new".to_string(),
        format!("/api/draft-texts/{}", "x".repeat(161)),
    ] {
        let (st, v) = h.json(Method::PUT, &uri, Some(body.clone())).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{uri}: {v}");
        assert_eq!(v["code"], "bad_scope", "{uri}: {v}");
        assert!(v["message"].is_string(), "{uri}: {v}");
    }
}

#[tokio::test]
async fn bad_client_id_400() {
    let h = H::new().await;
    let (st, body) = h.put("global-new", "t", "").await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "bad_client_id", "{body}");

    let too_long = "c".repeat(65);
    let (st, body) = h.put("global-new", "t", &too_long).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "bad_client_id", "{body}");

    // 64 bytes is the inclusive maximum.
    let at_max = "c".repeat(64);
    assert_eq!(h.put("global-new", "t", &at_max).await.0, StatusCode::OK);
}

#[tokio::test]
async fn unknown_session_404() {
    let h = H::new().await;
    for scope in [
        "vs-nope",
        "review-picker:worktree:nope",
        "review-picker:project:nope",
    ] {
        let (st, body) = h.put(scope, "t", "client-a").await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{scope}: {body}");
        assert_eq!(body["code"], "scope_not_found", "{scope}: {body}");
    }
}

#[tokio::test]
async fn put_emits_ws_event_with_client_id() {
    let h = H::new().await;
    let mut rx = h.broadcaster.subscribe();
    let (st, doc) = h.put("s1", "live draft", "client-a").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(doc["revision"], 1);

    match rx.try_recv().expect("one event per real change") {
        ServerEvent::DraftTextChanged {
            scope,
            text,
            revision,
            updated_at,
            client_id,
        } => {
            assert_eq!(scope, "s1");
            assert_eq!(text, "live draft");
            assert_eq!(revision, 1);
            assert!(updated_at.ends_with('Z'));
            assert_eq!(client_id.as_deref(), Some("client-a"));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(rx.try_recv().is_err(), "exactly one event per PUT");
}

#[tokio::test]
async fn put_unchanged_emits_nothing() {
    let h = H::new().await;
    let (_, first) = h.put("global-new", "same", "client-a").await;
    let mut rx = h.broadcaster.subscribe();

    let (st, doc) = h.put("global-new", "same", "client-b").await;
    assert_eq!(st, StatusCode::OK, "unchanged text is still a 200");
    assert_eq!(doc, first, "same doc: revision and clientId untouched");
    assert!(rx.try_recv().is_err(), "no event for unchanged text");
}

#[tokio::test]
async fn mounted_under_api_not_root() {
    let h = H::new().await;
    // A root-relative path falls through to the SPA fallback, never to a route.
    let (st, body) = h
        .json(
            Method::PUT,
            "/draft-texts/global-new",
            Some(json!({ "text": "t", "clientId": "client-a" })),
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "root PUT is not routed: {body}");
    assert!(body["drafts"].is_null() && body["code"].is_null(), "{body}");

    let (st, body) = h.json(Method::GET, "/draft-texts", None).await;
    // With no dist_path this is a 404; a build serving the embedded SPA would
    // answer 200 with index.html. Either way it is never the draft list.
    assert!(
        body["drafts"].is_null(),
        "root GET is not the list: {st} {body}"
    );

    let (st, body) = h.json(Method::GET, "/api/draft-texts", None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(body["drafts"].is_array(), "{body}");
}

/// Two clients write the same scope: the second is last-writer-wins with a
/// strictly newer revision, and both the reply and the event carry it.
#[tokio::test]
async fn second_put_after_other_client_put_is_newer_revision() {
    let h = H::new().await;
    let (st, first) = h.put("global-new", "from a", "client-a").await;
    assert_eq!(st, StatusCode::OK, "{first}");
    assert_eq!(first["revision"], 1);

    let mut rx = h.broadcaster.subscribe();
    let (st, second) = h.put("global-new", "from b", "client-b").await;
    assert_eq!(st, StatusCode::OK, "{second}");
    assert_eq!(second["revision"], 2, "prev + 1, no 409 dance: {second}");
    assert_eq!(second["text"], "from b");
    assert_eq!(second["clientId"], "client-b");
    assert!(
        second["updatedAt"].as_str().unwrap().ends_with('Z'),
        "ISO ms UTC: {second}"
    );

    let (st, got) = h.get("global-new").await;
    assert_eq!(st, StatusCode::OK, "{got}");
    assert_eq!(got, second, "GET serves the newer write");

    match rx.try_recv().expect("one event per real change") {
        ServerEvent::DraftTextChanged {
            scope,
            text,
            revision,
            client_id,
            ..
        } => {
            assert_eq!(scope, "global-new");
            assert_eq!(text, "from b");
            assert_eq!(revision, 2);
            assert_eq!(client_id.as_deref(), Some("client-b"));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(rx.try_recv().is_err(), "exactly one event per PUT");
}

/// `SessionDeleted` removes the row; the scope (a deleted session id) no longer
/// exists, so the GET is the revision-0 empty doc rather than a 404 — clients
/// that still hold a higher revision drop nothing and simply drop the binding.
#[tokio::test]
async fn delete_session_clears_row_and_get_returns_revision_0() {
    let h = H::new().await;
    // `sd1` is a direct session: deleting it needs no sibling promotion.
    let (st, doc) = h.put("sd1", "typed but unsent", "client-a").await;
    assert_eq!(st, StatusCode::OK, "{doc}");
    assert_eq!(doc["revision"], 1);
    assert_eq!(
        h.store.get_draft_text("sd1").await.unwrap().unwrap().text,
        "typed but unsent"
    );

    // Started explicitly, exactly as `run.rs` does after `build_state`.
    let subscriber = h.draft_text.spawn_session_deleted_subscriber();

    let (st, body) = h.delete_session("sd1").await;
    assert_eq!(st, StatusCode::OK, "delete failed: {body}");
    assert_eq!(body["ok"], true);

    let mut gone = false;
    for _ in 0..200 {
        if h.store.get_draft_text("sd1").await.unwrap().is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    subscriber.abort();
    assert!(gone, "the deleted session's draft row must be removed");

    let (st, doc) = h.get("sd1").await;
    assert_eq!(st, StatusCode::OK, "{doc}");
    assert_eq!(
        doc,
        json!({
            "scope": "sd1", "text": "", "revision": 0,
            "updatedAt": null, "clientId": null
        }),
        "a cleared scope reads as the absent doc, never a stale revision"
    );

    // Other scopes are untouched by the delete.
    assert_eq!(h.get("global-new").await.1["revision"], 0);
}
