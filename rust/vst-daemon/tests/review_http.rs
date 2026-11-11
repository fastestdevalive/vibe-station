//! HTTP-level tests for the review-comment routes (plan 04, 1.T9): worktree and
//! project twins mounted under `/api`, the 4xx taxonomy, and the push event.
//!
//! Real sqlite store, real router driven with `oneshot`; no TCP port is bound.

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

fn session(id: &str, worktree: Option<&str>, archived: bool) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree.map(Into::into),
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
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
        archived_at: archived.then(|| ISO.to_string()),
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

fn worktree(id: &str, sessions: Vec<SessionRecord>) -> WorktreeRecord {
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
        sessions,
        open_files: vec![],
    }
}

/// Project `p1` (folder `proj1`, direct session `sd1`) with worktree `w1` (branch `feat-w1`).
struct H {
    _tmp: TempDir,
    router: Router,
    broadcaster: Broadcaster,
    socket: String,
    _home: Option<vst_agents::home::HomeGuard>,
}

impl Drop for H {
    fn drop(&mut self) {
        // The delivery jobs only ever touch this isolated tmux socket.
        Tmux::with_socket(&self.socket).kill_server();
    }
}

impl H {
    async fn new() -> H {
        Self::build(false).await
    }

    /// With a claude mode on `s1` (a Terminal agent whose CLI can take comments).
    async fn with_terminal_agent() -> H {
        Self::build(true).await
    }

    async fn build(terminal_agent: bool) -> H {
        let tmp = tempfile::tempdir().unwrap();
        let socket = format!(
            "vst-rh-test-{}-{}",
            std::process::id(),
            tmp.path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace('.', "")
        );
        let home_guard = terminal_agent.then(|| {
            let dir = tmp.path().join("home").join(".vibe-station");
            std::fs::create_dir_all(&dir).unwrap();
            let mode = json!({
                "id": "m-claude", "name": "m-claude", "cli": "claude", "context": "",
                "createdAt": ISO, "model": null, "icon": "claude",
            });
            std::fs::write(dir.join("modes.json"), json!([mode]).to_string()).unwrap();
            // The agent's pane exists (a `sleep` that never shows a prompt), so a
            // delivery to it keeps waiting. Isolated socket, killed in `Drop`.
            Tmux::with_socket(&socket)
                .new_session(&vst_proc::tmux::NewSessionOptions {
                    name: "s1-pane".into(),
                    cwd: None,
                    env: Default::default(),
                    command: Some(vec!["sleep".into(), "600".into()]),
                    remain_on_exit: false,
                })
                .unwrap();
            vst_agents::home::with_home(tmp.path().join("home"))
        });
        let vst_home = tmp.path().join("home").join(".vibe-station");
        let proj = tmp.path().join("proj1");
        let paths = Paths::with_home(vst_home);
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
                direct_sessions: {
                    let mut v = vec![session("sd1", None, false)];
                    if terminal_agent {
                        let mut d = session("dr1", None, false);
                        d.lifecycle.state = LifecycleState::Drafting;
                        v.push(d);
                    }
                    v
                },
                direct_session_seq: Some(1),
                worktrees: vec![worktree("w1", {
                    let mut s1 = session("s1", Some("w1"), false);
                    if terminal_agent {
                        s1.mode_id = Some("m-claude".into());
                        s1.channel = Some(vst_types::Channel::Tmux);
                    }
                    vec![s1]
                })],
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
            store,
            broadcaster: broadcaster.clone(),
            json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::<
                vst_agents::json_agent_session::JsonAgentSession,
            >::new()),
            tmux: Tmux::with_socket(&socket),
            started_at: Instant::now(),
            version: "test".into(),
            paths,
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });
        H {
            _tmp: tmp,
            router: router_from_state(state),
            broadcaster,
            socket,
            _home: home_guard,
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

fn create_body(id: &str, path: &str, line: u32) -> Value {
    json!({
        "id": id, "path": path, "pathKind": "repo", "surface": "file",
        "lineStart": line, "lineEnd": line,
        "quote": format!("quote of {id}"), "prefix": "before ", "suffix": " after",
        "occurrence": 0, "text": format!("text of {id}")
    })
}

const BASES: [&str; 2] = ["/api/worktrees/w1/comments", "/api/projects/p1/comments"];

#[tokio::test]
async fn crud_for_worktree_and_project_scopes() {
    let h = H::new().await;
    for base in BASES {
        let (st, v) = h
            .json(Method::POST, base, Some(create_body("a", "src/a.rs", 3)))
            .await;
        assert_eq!(st, StatusCode::CREATED, "{base}: {v}");
        assert_eq!(v["comment"]["pin"], 1);
        assert_eq!(v["comment"]["anchor"], "anchored");
        // Same id again: 200 with the first comment.
        let (st, again) = h
            .json(Method::POST, base, Some(create_body("a", "src/a.rs", 3)))
            .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(again["comment"], v["comment"]);

        let (_, _) = h
            .json(Method::POST, base, Some(create_body("b", "src/b.rs", 1)))
            .await;
        let (st, list) = h.json(Method::GET, base, None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(list["comments"].as_array().unwrap().len(), 2);
        assert_eq!(list["nextPin"], 3);
        assert_eq!(list["terminalDeliveries"], json!([]));
        let (_, only_b) = h
            .json(Method::GET, &format!("{base}?path=src/b.rs"), None)
            .await;
        assert_eq!(only_b["comments"].as_array().unwrap().len(), 1);
        let (st, unsent) = h
            .json(Method::GET, &format!("{base}?delivery=unsent"), None)
            .await;
        assert_eq!(
            (st, unsent["comments"].as_array().unwrap().len()),
            (StatusCode::OK, 2)
        );
        let (st, bad) = h
            .json(Method::GET, &format!("{base}?delivery=weird"), None)
            .await;
        assert_eq!(
            (st, bad["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_delivery"))
        );

        let (st, got) = h.json(Method::GET, "/api/comments/a", None).await;
        assert_eq!((st, &got["comment"]), (StatusCode::OK, &v["comment"]));
        let (st, p) = h
            .json(
                Method::PATCH,
                "/api/comments/a",
                Some(json!({ "text": "edited", "version": 1 })),
            )
            .await;
        assert_eq!(st, StatusCode::OK, "{p}");
        assert_eq!(
            (
                p["comment"]["text"].as_str(),
                p["comment"]["version"].as_u64()
            ),
            (Some("edited"), Some(2))
        );
        let (st, d) = h.json(Method::DELETE, "/api/comments/a", None).await;
        assert_eq!((st, d["ok"].as_bool()), (StatusCode::OK, Some(true)));
        // GET / PATCH / DELETE after DELETE: 404.
        let (st, _) = h.json(Method::GET, "/api/comments/a", None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, e) = h
            .json(
                Method::PATCH,
                "/api/comments/a",
                Some(json!({ "text": "x" })),
            )
            .await;
        assert_eq!(
            (st, e["error"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found"))
        );
        let (st, _) = h.json(Method::DELETE, "/api/comments/a", None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        h.json(Method::DELETE, "/api/comments/b", None).await;
    }
}

/// An id owned by another scope (or held by a queued send) is `id_taken`, not
/// the unrelated `scope_mismatch`.
#[tokio::test]
async fn creating_an_id_owned_by_another_scope_is_id_taken() {
    let h = H::new().await;
    let (st, v) = h
        .json(
            Method::POST,
            BASES[0],
            Some(create_body("dup", "src/a.rs", 3)),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, v) = h
        .json(
            Method::POST,
            BASES[1],
            Some(create_body("dup", "src/a.rs", 3)),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::CONFLICT, Some("id_taken")),
        "{v}"
    );
}

#[tokio::test]
async fn unknown_scopes_are_404_and_routes_live_only_under_api() {
    let h = H::new().await;
    for uri in [
        "/api/worktrees/nope/comments",
        "/api/projects/nope/comments",
    ] {
        let (st, v) = h.json(Method::GET, uri, None).await;
        assert_eq!(
            (st, v["error"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found")),
            "{uri}"
        );
        let (st, _) = h
            .json(Method::POST, uri, Some(create_body("a", "f.rs", 1)))
            .await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{uri}");
    }
    // Unprefixed, the path hits the SPA fallback, never the comment list.
    let (_, v) = h.json(Method::GET, "/worktrees/w1/comments", None).await;
    assert!(v.get("comments").is_none());
}

#[tokio::test]
async fn validation_errors_use_their_status_codes() {
    let h = H::new().await;
    let base = BASES[0];
    let mut long_text = create_body("a", "f.rs", 1);
    long_text["text"] = json!("x".repeat(8193));
    let (st, v) = h.json(Method::POST, base, Some(long_text)).await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("text_too_long"))
    );
    let mut long_quote = create_body("a", "f.rs", 1);
    long_quote["quote"] = json!("x".repeat(2049));
    let (st, v) = h.json(Method::POST, base, Some(long_quote)).await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("quote_too_long"))
    );
    for path in ["a\nb.rs", "../x", "/abs.rs", "a\u{7}.rs"] {
        let (st, v) = h
            .json(Method::POST, base, Some(create_body("a", path, 1)))
            .await;
        assert_eq!(
            (st, v["error"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_path")),
            "{path:?}"
        );
    }
    let mut bad_anchor = create_body("a", "f.rs", 1);
    bad_anchor["surface"] = json!("diff");
    let (st, v) = h.json(Method::POST, base, Some(bad_anchor)).await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_anchor"))
    );
    // An option-shaped base sha must never be stored (it would reach `git diff`).
    let marker = h._tmp.path().join("x");
    let mut evil = create_body("a", "f.rs", 1);
    evil["surface"] = json!("diff");
    evil["diffScope"] = json!("branch");
    evil["side"] = json!("new");
    evil["newStart"] = json!(1);
    evil["baseSha"] = json!(format!("--output={}", marker.display()));
    let (st, v) = h.json(Method::POST, base, Some(evil)).await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_anchor"))
    );
    assert!(!marker.exists());
    let (st, v) = h
        .json(
            Method::POST,
            &format!("{base}/attach"),
            Some(json!({ "composerKey": "oops" })),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_composer"))
    );
    // Nothing was created by any of the above.
    let (_, list) = h.json(Method::GET, base, None).await;
    assert_eq!(list["comments"], json!([]));
}

#[tokio::test]
async fn the_501st_comment_is_409_cap_reached() {
    let h = H::new().await;
    let base = BASES[0];
    for n in 0..500 {
        let (st, _) = h
            .json(
                Method::POST,
                base,
                Some(create_body(&format!("c{n}"), "f.rs", 1)),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED);
    }
    let (st, v) = h
        .json(Method::POST, base, Some(create_body("extra", "f.rs", 1)))
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::CONFLICT, Some("cap_reached"))
    );
}

#[tokio::test]
async fn render_is_never_413_and_returns_the_message_format() {
    let h = H::new().await;
    let base = BASES[0];
    for n in 0..210 {
        let mut b = create_body(&format!("c{n}"), "f.rs", n + 1);
        b["text"] = json!("y".repeat(2000));
        h.json(Method::POST, base, Some(b)).await;
    }
    let (st, v) = h
        .json(
            Method::POST,
            &format!("{base}/render"),
            Some(json!({ "message": "Please look" })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["count"], 210);
    assert!(v["bytes"].as_u64().unwrap() > 131_072);
    assert!(v["text"]
        .as_str()
        .unwrap()
        .starts_with("Please look\n\nReview comments (210) · feat-w1\n"));
    let (_, one) = h
        .json(
            Method::POST,
            &format!("{base}/render"),
            Some(json!({ "commentIds": ["c0"] })),
        )
        .await;
    assert_eq!(one["count"], 1);
}

#[tokio::test]
async fn attach_detach_and_dismiss_restored() {
    let h = H::new().await;
    let base = BASES[0];
    for id in ["a", "b"] {
        h.json(Method::POST, base, Some(create_body(id, "f.rs", 1)))
            .await;
    }
    let (st, v) = h
        .json(
            Method::POST,
            &format!("{base}/attach"),
            Some(json!({ "composerKey": "session:s1" })),
        )
        .await;
    assert_eq!(
        (st, v["attached"].as_array().map(Vec::len)),
        (StatusCode::OK, Some(2))
    );
    let (_, list) = h
        .json(Method::GET, &format!("{base}?delivery=unsent"), None)
        .await;
    assert_eq!(
        list["comments"],
        json!([]),
        "attached comments are not unsent"
    );
    let (st, v) = h
        .json(
            Method::POST,
            &format!("{base}/detach"),
            Some(json!({ "commentIds": ["a"] })),
        )
        .await;
    assert_eq!((st, v["detached"].clone()), (StatusCode::OK, json!(["a"])));
    let (st, v) = h
        .json(
            Method::POST,
            &format!("{base}/attach"),
            Some(json!({ "composerKey": "session:s1", "refreshOnly": true })),
        )
        .await;
    assert_eq!((st, v["attached"].clone()), (StatusCode::OK, json!(["b"])));
    let (st, v) = h
        .json(Method::POST, &format!("{base}/dismiss-restored"), None)
        .await;
    assert_eq!((st, v["cleared"].clone()), (StatusCode::OK, json!(0)));
}

#[tokio::test]
async fn changes_are_pushed_as_one_coalesced_event() {
    let h = H::new().await;
    let mut rx = h.broadcaster.subscribe();
    let base = BASES[1];
    h.json(Method::POST, base, Some(create_body("a", "f.rs", 1)))
        .await;
    h.json(Method::POST, base, Some(create_body("b", "f.rs", 2)))
        .await;
    let ev = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let ServerEvent::CommentsChanged {
                scope_kind,
                scope_id,
                upserted,
                deleted,
            } = rx.recv().await.unwrap()
            {
                return (scope_kind, scope_id, upserted, deleted);
            }
        }
    })
    .await
    .expect("comments:changed within the coalesce window");
    assert_eq!((ev.0.as_str(), ev.1.as_str()), ("project", "p1"));
    assert_eq!(ev.2.len(), 2);
    assert!(ev.3.is_empty());
}

// ── Terminal deliveries (plan 04, 3.2) ───────────────────────────────────────

#[tokio::test]
async fn terminal_delivery_routes_live_under_api_with_their_status_codes() {
    let h = H::with_terminal_agent().await;
    for id in ["c1", "c2"] {
        let (st, _) = h
            .json(
                Method::POST,
                "/api/worktrees/w1/comments",
                Some(create_body(id, "src/a.rs", 3)),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED);
    }
    let mut rx = h.broadcaster.subscribe();
    let delivery = |id: &str, session: &str, ids: Value| json!({ "terminalDeliveryId": id, "sessionId": session, "commentIds": ids, "message": "look" });

    // Unsupported: a session without a Terminal-capable CLI (the project's direct
    // agent has no mode) is 400 TERMINAL_DELIVERY_UNSUPPORTED.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/projects/p1/terminal-deliveries",
            Some(delivery("td-0", "sd1", json!(["c1"]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (
            StatusCode::BAD_REQUEST,
            Some("TERMINAL_DELIVERY_UNSUPPORTED")
        ),
        "{v}"
    );
    // An empty delivery is 400 no_comments.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-empty", "s1", json!([]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("no_comments")),
        "{v}"
    );
    // Unknown session and unknown scope are 404; stale ids are 409.
    let (st, _) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-0", "nope", json!(["c1"]))),
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-0", "s1", json!(["c1", "ghost"]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str(), v["remaining"].as_u64()),
        (StatusCode::CONFLICT, Some("comments_changed"), Some(1))
    );
    // A session of another scope is refused as a scope mismatch.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-0", "sd1", json!(["c1"]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::CONFLICT, Some("scope_mismatch")),
        "{v}"
    );

    // 202 { delivery }: waiting, both comments leave the list, the tray gets it.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-1", "s1", json!(["c1", "c2"]))),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["delivery"]["id"], "td-1");
    assert_eq!(v["delivery"]["state"], "waiting");
    assert_eq!(v["delivery"]["commentCount"], 2);
    assert_eq!(v["delivery"]["scopeKind"], "worktree");
    let (_, list) = h
        .json(Method::GET, "/api/worktrees/w1/comments", None)
        .await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 0);
    assert_eq!(list["terminalDeliveries"][0]["id"], "td-1");
    let mut saw = false;
    while let Ok(ev) = rx.try_recv() {
        if let ServerEvent::TerminalDeliveryUpdated { delivery } = ev {
            saw |= delivery.id == "td-1";
        }
    }
    assert!(saw, "terminal-delivery:updated is pushed");

    // Same id again: the first delivery, no second job.
    let (st, again) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-1", "s1", json!(["c1", "c2"]))),
        )
        .await;
    assert_eq!(
        (st, &again["delivery"]["id"]),
        (StatusCode::ACCEPTED, &v["delivery"]["id"])
    );
    // A second delivery to the busy session is 409 delivery_in_flight.
    let (st, busy) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/terminal-deliveries",
            Some(delivery("td-2", "s1", json!(["c3"]))),
        )
        .await;
    assert_eq!(
        (st, busy["error"].as_str()),
        (StatusCode::CONFLICT, Some("delivery_in_flight")),
        "{busy}"
    );

    // Readiness is a bounded probe: this pane does not exist, so `unknown`.
    let (st, r) = h
        .json(Method::GET, "/api/sessions/s1/terminal-readiness", None)
        .await;
    assert_eq!(
        (st, r["readiness"].as_str()),
        (StatusCode::OK, Some("unknown"))
    );
    // Unprefixed routes are the SPA fallback, never the API.
    let (_, fallback) = h
        .json(Method::GET, "/sessions/s1/terminal-readiness", None)
        .await;
    assert!(fallback.get("readiness").is_none());

    // Cancel: 200 and the comments come back; unknown id is 404.
    let (st, v) = h
        .json(Method::DELETE, "/api/terminal-deliveries/nope", None)
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(v["message"].as_str(), Some("delivery not found"), "{v}");
    let (st, v) = h
        .json(Method::DELETE, "/api/terminal-deliveries/td-1", None)
        .await;
    assert_eq!((st, &v["ok"]), (StatusCode::OK, &json!(true)));
    let start = Instant::now();
    loop {
        let (_, list) = h
            .json(Method::GET, "/api/worktrees/w1/comments", None)
            .await;
        if list["comments"].as_array().unwrap().len() == 2 {
            assert_eq!(list["comments"][0]["restoredReason"], "send_cancelled");
            assert_eq!(list["terminalDeliveries"].as_array().unwrap().len(), 0);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "never restored");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn starting_a_draft_with_comments_maps_review_refusals() {
    let h = H::with_terminal_agent().await;
    let (st, _) = h
        .json(
            Method::POST,
            "/api/projects/p1/comments",
            Some(create_body("c1", "src/a.rs", 3)),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let start = |entry: &str, choice: Option<&str>, ids: Value| {
        let mut cfg = json!({
            "entryPoint": entry, "modeId": "m-claude", "channel": "json", "useWorktree": false
        });
        if let Some(c) = choice {
            cfg["worktreeChoice"] = json!(c);
            cfg["branch"] = json!("feat/x");
        }
        json!({ "draftPrompt": "", "draftConfig": cfg, "reviewCommentIds": ids })
    };
    // A new worktree would leave the comments' scope: 409 scope_changed.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/dr1/start",
            Some(start("worktree", Some("new"), json!(["c1"]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::CONFLICT, Some("scope_changed")),
        "{v}"
    );
    // Stale ids: 409 comments_changed with what remains; the draft stays a draft.
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/dr1/start",
            Some(start("direct", None, json!(["c1", "ghost"]))),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str(), v["remaining"].as_u64()),
        (StatusCode::CONFLICT, Some("comments_changed"), Some(1)),
        "{v}"
    );
    // An empty prompt without comments is still refused.
    let (st, _) = h
        .json(
            Method::POST,
            "/api/sessions/dr1/start",
            Some(start("direct", None, json!([]))),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (_, list) = h.json(Method::GET, "/api/projects/p1/comments", None).await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn starting_a_terminal_draft_with_an_oversized_review_is_413_and_restores() {
    let h = H::with_terminal_agent().await;
    for (id, line) in [("big1", 3), ("big2", 4)] {
        let mut body = create_body(id, "src/a.rs", line);
        body["text"] = json!("x".repeat(8000));
        let (st, v) = h
            .json(Method::POST, "/api/projects/p1/comments", Some(body))
            .await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
    }
    let cfg = json!({
        "entryPoint": "direct", "modeId": "m-claude", "channel": "tmux", "useWorktree": false
    });
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/dr1/start",
            Some(json!({
                "draftPrompt": "", "draftConfig": cfg, "reviewCommentIds": ["big1", "big2"]
            })),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str(), v["unit"].as_str()),
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            Some("review_too_large"),
            Some("bytes")
        ),
        "{v}"
    );
    assert_eq!(v["limit"], 14 * 1024, "{v}");
    // Nothing was promoted and both comments are back in the panel, unheld.
    let (_, list) = h.json(Method::GET, "/api/projects/p1/comments", None).await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 2, "{list}");
}

#[tokio::test]
async fn a_terminal_start_counts_the_draft_text_and_shell_quoting_growth() {
    let h = H::with_terminal_agent().await;
    // Three comments of 1000 apostrophes: ~3 KB of block (well under the old
    // 12 KiB block check) that quotes to ~12 KB, plus a 6 KiB draft prompt.
    for (id, line) in [("q1", 3), ("q2", 4), ("q3", 5)] {
        let mut body = create_body(id, "src/a.rs", line);
        body["text"] = json!("'".repeat(1000));
        let (st, v) = h
            .json(Method::POST, "/api/projects/p1/comments", Some(body))
            .await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
    }
    let cfg = json!({
        "entryPoint": "direct", "modeId": "m-claude", "channel": "tmux", "useWorktree": false
    });
    let (st, v) = h
        .json(
            Method::POST,
            "/api/sessions/dr1/start",
            Some(json!({
                "draftPrompt": "w".repeat(6 * 1024), "draftConfig": cfg,
                "reviewCommentIds": ["q1", "q2", "q3"]
            })),
        )
        .await;
    assert_eq!(
        (st, v["error"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("review_too_large")),
        "{v}"
    );
    let (_, list) = h.json(Method::GET, "/api/projects/p1/comments", None).await;
    assert_eq!(list["comments"].as_array().unwrap().len(), 3, "{list}");
}
