//! HTTP tests for the stat routes (A4.T2), under `/api`:
//! `GET .../stat/*path` (in-root only, absolute or escaping = 403) and
//! `GET .../artifacts/:artifactId/stat` (artifact gate only).
//!
//! Real file system, real sqlite store, real router driven with `oneshot`;
//! no TCP port is bound. Harness copied from `artifacts_http.rs`.

//! real router driven with `oneshot`; no TCP port is bound.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, BuildServerOptions};
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
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

/// One daemon over a tempdir: project `p1` (direct session `sd1`), worktrees
/// `w1` (sessions `s1`, `s-rate`, `s-batch`, `s-arch` archived) and `w2` (`s2`).
/// `tmp` is deliberately NOT canonicalized: on macOS it lives under the
/// `/var` -> `/private/var` symlink, which the gate must cope with.
struct H {
    tmp: TempDir,
    router: Router,
    store: StoreHandle,
    outside: PathBuf,
    wt1: PathBuf,
}

impl H {
    async fn new() -> H {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let vst_home = home.join(".vibe-station");
        let outside = tmp.path().join("outside");
        let proj = tmp.path().join("proj1");
        let paths = Paths::with_home(vst_home.clone());
        let wt1 = paths.worktree_path("p1", "w1");
        let wt2 = paths.worktree_path("p1", "w2");
        for d in [&outside, &proj, &wt1, &wt2, &home] {
            std::fs::create_dir_all(d).unwrap();
        }
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
                direct_sessions: vec![session("sd1", None, false)],
                direct_session_seq: Some(1),
                worktrees: vec![
                    worktree(
                        "w1",
                        vec![
                            session("s1", Some("w1"), false),
                            session("s-rate", Some("w1"), false),
                            session("s-batch", Some("w1"), false),
                            session("s-arch", Some("w1"), true),
                        ],
                    ),
                    worktree("w2", vec![session("s2", Some("w2"), false)]),
                ],
                next_worktree_num: Some(3),
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
            tmux: vst_proc::test_support::isolated_tmux(),
            started_at: Instant::now(),
            version: "test".into(),
            update: vst_daemon::update::UpdateService::for_tests(paths.vst_home()),
            paths,
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });
        let router = router_from_state(state.clone());
        H {
            tmp,
            router,
            store,
            outside,
            wt1,
        }
    }

    async fn call(
        &self,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
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
        let (status, headers) = (resp.status(), resp.headers().clone());
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    async fn json(&self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (s, _, b) = self.call(method, uri, body).await;
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    /// `POST /api/artifacts` for `token`; returns (status, body).
    async fn add(&self, token: &str, paths: &[&Path]) -> (StatusCode, Value) {
        let paths: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        self.json(
            Method::POST,
            "/api/artifacts",
            Some(json!({ "spawnToken": token, "paths": paths })),
        )
        .await
    }

    /// Write `outside/<name>`, add it as session `token`, return its artifact id.
    async fn add_outside(&self, token: &str, name: &str, content: &[u8]) -> (PathBuf, String) {
        let p = self.outside.join(name);
        std::fs::write(&p, content).unwrap();
        let (st, body) = self.add(token, &[&p]).await;
        assert_eq!(st, StatusCode::OK, "{body}");
        let id = body["results"][0]["artifact"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("add failed: {body}"))
            .to_string();
        (std::fs::canonicalize(&p).unwrap(), id)
    }
}

// ---------------------------------------------------------------- A4.T2

fn canon(p: &Path) -> String {
    std::fs::canonicalize(p)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn worktree_stat_in_root_file_matches_the_contract() {
    let h = H::new().await;
    std::fs::write(h.wt1.join("a.txt"), "a\nb\n").unwrap();
    let (st, v) = h
        .json(Method::GET, "/api/worktrees/w1/stat/a.txt", None)
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["path"], "a.txt");
    assert_eq!(v["absolutePath"], canon(&h.wt1.join("a.txt")));
    assert_eq!(v["kind"], "file");
    assert_eq!(v["size"], 4);
    assert_eq!(v["lineCount"], 2);
    assert_eq!(v["inRoot"], true);
    assert!(v["modifiedMs"].as_i64().is_some_and(|ms| ms > 0));
}

#[tokio::test]
async fn project_stat_in_root_file_is_served_under_api() {
    let h = H::new().await;
    std::fs::write(h.tmp.path().join("proj1").join("readme.md"), "hi\n").unwrap();
    let (st, v) = h
        .json(Method::GET, "/api/projects/p1/stat/readme.md", None)
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["kind"], "file");
    assert_eq!(v["lineCount"], 1);
    assert_eq!(v["inRoot"], true);
}

#[tokio::test]
async fn in_root_stat_refuses_an_absolute_artifact_path() {
    let h = H::new().await;
    let (path, _id) = h.add_outside("s1", "plan.md", b"# plan\n").await;
    let uri = format!("/api/worktrees/w1/stat/{}", path.to_string_lossy());
    let (st, v) = h.json(Method::GET, &uri, None).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{v}");
    assert!(v["error"].is_string(), "{v}");
}

#[tokio::test]
async fn artifact_stat_of_an_outside_row_goes_through_the_artifact_gate() {
    let h = H::new().await;
    let content = b"# plan\n";
    let (path, id) = h.add_outside("s1", "plan.md", content).await;
    let (st, v) = h
        .json(
            Method::GET,
            &format!("/api/worktrees/w1/artifacts/{id}/stat"),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["kind"], "file");
    assert_eq!(v["size"], content.len() as u64);
    assert_eq!(v["absolutePath"], path.to_string_lossy().as_ref());
    assert_eq!(v["inRoot"], false);
    assert!(v["lineCount"].is_null());
}

#[tokio::test]
async fn artifact_stat_under_another_worktree_is_not_found() {
    let h = H::new().await;
    let (_path, id) = h.add_outside("s1", "plan.md", b"x").await;
    let (st, v) = h
        .json(
            Method::GET,
            &format!("/api/worktrees/w2/artifacts/{id}/stat"),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
}

#[tokio::test]
async fn artifact_stat_unknown_id_is_not_found() {
    let h = H::new().await;
    let (st, v) = h
        .json(
            Method::GET,
            "/api/worktrees/w1/artifacts/no-such-id/stat",
            None,
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
}

#[tokio::test]
async fn artifact_stat_of_a_deleted_file_is_not_found() {
    let h = H::new().await;
    let (path, id) = h.add_outside("s1", "gone.md", b"bye").await;
    std::fs::remove_file(&path).unwrap();
    let (st, v) = h
        .json(
            Method::GET,
            &format!("/api/worktrees/w1/artifacts/{id}/stat"),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
}

#[tokio::test]
async fn artifact_stat_of_a_denylisted_row_is_forbidden() {
    let h = H::new().await;
    let (path, id) = h.add_outside("s1", "plan.md", b"x").await;
    // Re-point the row at a `*.pem` name through the store (intake would never
    // record that name); the stat gate's denylist is what is under test.
    let pem = canon(&h.outside).into_bytes();
    let pem = format!("{}/secret.pem", String::from_utf8_lossy(&pem));
    std::fs::rename(&path, &pem).unwrap();
    h.store
        .update_path(&id, &pem, &pem, false)
        .await
        .unwrap()
        .expect("row re-pointed");
    let (st, v) = h
        .json(
            Method::GET,
            &format!("/api/worktrees/w1/artifacts/{id}/stat"),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{v}");
}
