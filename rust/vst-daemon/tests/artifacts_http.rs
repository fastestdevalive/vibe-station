//! HTTP-level tests for artifacts: the six `/api/artifacts*` routes, the
//! in-root file-route read gate (symlink escapes, artifact exception, open-files)
//! and the purge on worktree/project delete (plan 4.T1-4.T4, 4.T6;
//! security-boundary rows S1-S12, S15-S19, S21).
//!
//! Real file system (tempdirs, symlinks, hard links, FIFOs), real sqlite store,
//! real router driven with `oneshot`; no TCP port is bound.

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, AppState, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::artifacts::{ArtifactSink, FileEffect, ScopeKey, WriteContext};
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

/// One daemon over a tempdir: project `p1` (direct session `sd1`), worktrees
/// `w1` (sessions `s1`, `s-rate`, `s-batch`, `s-arch` archived) and `w2` (`s2`).
/// `tmp` is deliberately NOT canonicalized: on macOS it lives under the
/// `/var` -> `/private/var` symlink, which the gate must cope with.
struct H {
    tmp: TempDir,
    router: Router,
    state: AppState,
    broadcaster: Broadcaster,
    store: StoreHandle,
    outside: PathBuf,
    home: PathBuf,
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
            tmux: Tmux::new(),
            started_at: Instant::now(),
            version: "test".into(),
            paths,
            limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".into()),
        });
        let router = router_from_state(state.clone());
        H {
            tmp,
            router,
            state,
            broadcaster,
            store,
            outside,
            home,
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

    async fn get(&self, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        self.call(Method::GET, uri, None).await
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

    async fn list(&self, scope: &str) -> Value {
        let (st, v) = self.json(Method::GET, scope, None).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        v
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

// ---------------------------------------------------------------- 4.T1

#[tokio::test]
async fn add_list_pin_remove_roundtrip() {
    let h = H::new().await;
    let (path, id) = h.add_outside("s1", "plan.md", b"# plan\n").await;

    let v = h.list("/api/worktrees/w1/artifacts").await;
    assert_eq!(v["cap"], 500);
    assert_eq!(v["total"], 1);
    assert!(v["rev"].is_u64());
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["items"][0]["id"], id);
    assert_eq!(v["items"][0]["inRepo"], false);
    assert_eq!(v["items"][0]["path"], path.to_string_lossy().as_ref());
    assert_eq!(v["items"][0]["writers"][0], "s1");

    // add result shape
    let (_, body) = h.add("s1", &[&path]).await;
    assert_eq!(body["results"][0]["outsideWorktree"], true);

    // pin / unpin
    let (st, pinned) = h
        .json(
            Method::POST,
            &format!("/api/artifacts/{id}/pin"),
            Some(json!({ "pinned": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(pinned["artifact"]["pinned"], true);
    let (st, e) = h
        .json(
            Method::POST,
            "/api/artifacts/nope/pin",
            Some(json!({ "pinned": true })),
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(e["error"], "ARTIFACT_NOT_FOUND");

    // unknown scopes 404 NOT_FOUND
    for uri in [
        "/api/worktrees/nope/artifacts",
        "/api/projects/nope/artifacts",
    ] {
        let (st, e) = h.json(Method::GET, uri, None).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(e["error"], "NOT_FOUND");
    }

    // remove: hidden from the list, content is 404 (S18), second delete 404
    let (st, ok) = h
        .json(Method::DELETE, &format!("/api/artifacts/{id}"), None)
        .await;
    assert_eq!((st, ok["ok"].clone()), (StatusCode::OK, json!(true)));
    let v = h.list("/api/worktrees/w1/artifacts").await;
    assert_eq!(v["items"].as_array().unwrap().len(), 0);
    assert_eq!(v["total"], 1, "hidden rows count toward the cap");
    let (st, e) = h
        .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(e["error"], "ARTIFACT_NOT_FOUND");
    let (st, _) = h
        .json(Method::DELETE, &format!("/api/artifacts/{id}"), None)
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn project_scope_lists_direct_session_artifacts() {
    let h = H::new().await;
    let (_, id) = h.add_outside("sd1", "notes.md", b"n").await;
    let v = h.list("/api/projects/p1/artifacts").await;
    assert_eq!(v["items"][0]["id"], id);
    assert_eq!(v["items"][0]["scopeKind"], "project");
    let w = h.list("/api/worktrees/w1/artifacts").await;
    assert_eq!(
        w["items"].as_array().unwrap().len(),
        0,
        "scopes are separate"
    );
}

#[tokio::test]
async fn pin_limit_is_409_at_the_51st() {
    let h = H::new().await;
    let mut ids = Vec::new();
    for batch in [(0..50), (50..51)] {
        let paths: Vec<PathBuf> = batch
            .map(|i| {
                let p = h.outside.join(format!("f{i}.md"));
                std::fs::write(&p, format!("{i}")).unwrap();
                p
            })
            .collect();
        let refs: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
        let (st, body) = h.add("s1", &refs).await;
        assert_eq!(st, StatusCode::OK, "{body}");
        for r in body["results"].as_array().unwrap() {
            ids.push(r["artifact"]["id"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(ids.len(), 51);
    for id in &ids[..50] {
        let (st, _) = h
            .json(
                Method::POST,
                &format!("/api/artifacts/{id}/pin"),
                Some(json!({ "pinned": true })),
            )
            .await;
        assert_eq!(st, StatusCode::OK);
    }
    let (st, e) = h
        .json(
            Method::POST,
            &format!("/api/artifacts/{}/pin", ids[50]),
            Some(json!({ "pinned": true })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(e["error"], "PIN_LIMIT");
}

#[tokio::test]
async fn content_matrix_and_hardening_headers() {
    let h = H::new().await;

    // 200 text with the S12 headers
    let (_, id) = h.add_outside("s1", "ok.md", b"hello\n").await;
    let (st, hd, body) = h.get(&format!("/api/artifacts/{id}/content")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(text(&body), "hello\n");
    assert_eq!(hd["content-type"], "text/plain; charset=utf-8");
    assert_eq!(hd["x-content-type-options"], "nosniff");
    assert_eq!(hd["cache-control"], "no-store");
    assert!(hd.contains_key("etag"));
    assert!(hd["content-security-policy"]
        .to_str()
        .unwrap()
        .starts_with("sandbox; default-src 'none'"));
    assert_eq!(
        hd["content-security-policy"],
        vst_daemon::server::RAW_FILE_CSP,
        "artifact CSP must equal the raw-file CSP"
    );
    assert!(!hd.contains_key("x-vst-truncated-total"));

    // truncated text: first 1 MiB + total header
    let big = vec![b'a'; 2 * 1024 * 1024];
    let (_, id) = h.add_outside("s1", "big.txt", &big).await;
    let (st, hd, body) = h.get(&format!("/api/artifacts/{id}/content")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body.len(), 1024 * 1024);
    assert_eq!(
        hd["x-vst-truncated-total"],
        (2 * 1024 * 1024).to_string().as_str()
    );

    // image
    let (_, id) = h.add_outside("s1", "shot.png", b"\x89PNG....").await;
    let (st, hd, _) = h.get(&format!("/api/artifacts/{id}/content")).await;
    assert_eq!(
        (st, hd["content-type"].to_str().unwrap()),
        (StatusCode::OK, "image/png")
    );

    // 415 binary
    let (_, id) = h.add_outside("s1", "blob.bin", b"ab\0cd").await;
    let (st, e) = h
        .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
        .await;
    assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(e["error"], "ARTIFACT_BINARY");
    assert_eq!(e["size"], 5);

    // 422 image over 10 MiB
    let bigimg = h.outside.join("huge.png");
    std::fs::File::create(&bigimg)
        .unwrap()
        .set_len(11 * 1024 * 1024)
        .unwrap();
    let (st, body) = h.add("s1", &[&bigimg]).await;
    assert_eq!(st, StatusCode::OK);
    let id = body["results"][0]["artifact"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (st, e) = h
        .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
        .await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(e["error"], "ARTIFACT_TOO_LARGE");

    // 410 once the file is gone (no unique hash match to follow)
    let (p, id) = h.add_outside("s1", "gone.md", b"bye").await;
    std::fs::remove_file(&p).unwrap();
    let (st, e) = h
        .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
        .await;
    assert_eq!(st, StatusCode::GONE);
    assert_eq!(e["error"], "ARTIFACT_MISSING");

    // 403 UNREADABLE (skipped when running with privileges that ignore modes)
    let (p, id) = h.add_outside("s1", "locked.md", b"x").await;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&p).is_err() {
        let (st, e) = h
            .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
            .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert_eq!(e["error"], "ARTIFACT_UNREADABLE");
        assert_eq!(e["detail"], "EACCES");
    }
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
}

// S5: the row path is later replaced by a symlink to a denied file.
#[tokio::test]
async fn content_refuses_a_path_swapped_for_a_symlink() {
    let h = H::new().await;
    let secret = h.outside.join("secret.txt");
    std::fs::write(&secret, "TOPSECRET").unwrap();
    let (p, id) = h.add_outside("s1", "swap.md", b"fine").await;
    std::fs::remove_file(&p).unwrap();
    symlink(&secret, &p).unwrap();
    let (st, hd, body) = h.get(&format!("/api/artifacts/{id}/content")).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(!text(&body).contains("TOPSECRET"));
    assert_eq!(hd["x-content-type-options"], "nosniff");
    let e: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(e["error"], "ARTIFACT_DENIED");
}

// S6: an outside-repo artifact hard-linked to another file (nlink 2).
#[tokio::test]
async fn content_refuses_an_outside_repo_hard_link() {
    let h = H::new().await;
    let (p, id) = h.add_outside("s1", "linked.md", b"fine").await;
    std::fs::hard_link(&p, h.outside.join("other-name")).unwrap();
    let (st, e) = h
        .json(Method::GET, &format!("/api/artifacts/{id}/content"), None)
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(e["error"], "ARTIFACT_DENIED");
}

// ---------------------------------------------------------------- 4.T2

fn wt_file(h: &H, rel: &str, content: &[u8]) -> PathBuf {
    let p = h.wt1.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, content).unwrap();
    p
}

#[tokio::test]
async fn in_root_route_blocks_traversal_and_symlink_escapes() {
    let h = H::new().await;
    let secret = h.outside.join("secret.txt");
    std::fs::write(&secret, "TOPSECRET").unwrap();
    wt_file(&h, "docs/a.md", b"in repo");
    std::fs::create_dir_all(h.outside.join("dir")).unwrap();
    std::fs::write(h.outside.join("dir/inner.txt"), "TOPSECRET2").unwrap();
    symlink(&secret, h.wt1.join("docs/leak")).unwrap();
    symlink(h.outside.join("dir"), h.wt1.join("dirleak")).unwrap();
    symlink(h.wt1.join("docs/a.md"), h.wt1.join("docs/inner-link")).unwrap();

    let files = "/api/worktrees/w1/files";
    // plain + in-repo symlink to in-repo file (regression guard) -> 200
    for rel in ["docs/a.md", "docs/inner-link"] {
        let (st, _, b) = h.get(&format!("{files}/{rel}")).await;
        assert_eq!(
            (st, text(&b).as_str()),
            (StatusCode::OK, "in repo"),
            "{rel}"
        );
    }
    // S1 traversal -> 403 lexical
    let (st, _, _) = h.get(&format!("{files}/../../../../etc/passwd")).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    // S2 symlink to an outside file, S4 symlinked parent dir -> 403, not served
    for rel in ["docs/leak", "dirleak/inner.txt"] {
        let (st, _, b) = h.get(&format!("{files}/{rel}")).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{rel}");
        assert!(!text(&b).contains("TOPSECRET"), "{rel}");
    }
    // a missing file stays 404, not 403
    let (st, _, _) = h.get(&format!("{files}/docs/nope.md")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // an absolute path outside the root that is no artifact: 403, even if missing
    for abs in [
        secret.to_string_lossy().to_string(),
        "/definitely/missing".into(),
    ] {
        let (st, _, b) = h.get(&format!("{files}/{abs}")).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{abs}");
        assert!(!text(&b).contains("TOPSECRET"));
    }
    // tree over a symlinked dir pointing outside -> 403 (Risk #16); inside still lists
    let (st, _, _) = h.get("/api/worktrees/w1/tree?path=dirleak").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _, _) = h.get("/api/worktrees/w1/tree?path=docs").await;
    assert_eq!(st, StatusCode::OK);
    // gutter on an escaping symlink -> 403
    let (st, _, _) = h.get("/api/worktrees/w1/gutter/docs/leak").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn project_routes_apply_the_same_gate() {
    let h = H::new().await;
    let proj = h.tmp.path().join("proj1");
    std::fs::write(h.outside.join("secret.txt"), "TOPSECRET").unwrap();
    std::fs::write(proj.join("a.md"), "mine").unwrap();
    symlink(h.outside.join("secret.txt"), proj.join("leak")).unwrap();
    let (st, _, b) = h.get("/api/projects/p1/files/a.md").await;
    assert_eq!((st, text(&b).as_str()), (StatusCode::OK, "mine"));
    let (st, _, b) = h.get("/api/projects/p1/files/leak").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(!text(&b).contains("TOPSECRET"));
    let (st, _, _) = h.get("/api/projects/p1/files/nope").await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // artifact exception per scope
    let (art, _) = h.add_outside("sd1", "p.md", b"project artifact").await;
    symlink(&art, proj.join("alias")).unwrap();
    let (st, _, b) = h.get("/api/projects/p1/files/alias").await;
    assert_eq!(
        (st, text(&b).as_str()),
        (StatusCode::OK, "project artifact")
    );
    let (st, _, _) = h.get("/api/projects/p1/gutter/alias").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

// S3 + the 20 MB rule: an in-repo symlink to an artifact is served by the
// artifact reader (capped at 1 MiB), never by `read_file_response`.
#[tokio::test]
async fn symlink_to_an_artifact_is_served_by_the_artifact_reader() {
    let h = H::new().await;
    let big = vec![b'z'; 20 * 1024 * 1024];
    let (art, _) = h.add_outside("s1", "big.log", &big).await;
    symlink(&art, h.wt1.join("alias.log")).unwrap();

    let (st, hd, body) = h.get("/api/worktrees/w1/files/alias.log").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body.len(), 1024 * 1024, "truncated by the artifact reader");
    assert_eq!(
        hd["x-vst-truncated-total"],
        (20 * 1024 * 1024).to_string().as_str()
    );
    assert_eq!(hd["cache-control"], "no-store");
    assert_eq!(hd["x-content-type-options"], "nosniff");

    // absolute artifact path through the files route works too
    let (st, _, _) = h
        .get(&format!(
            "/api/worktrees/w1/files/{}",
            art.to_string_lossy()
        ))
        .await;
    assert_eq!(st, StatusCode::OK);

    // gutter has NO artifact exception
    let (st, _, _) = h.get("/api/worktrees/w1/gutter/alias.log").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

// S11: the allowlist is per scope.
#[tokio::test]
async fn an_artifact_of_another_worktree_is_not_readable_here() {
    let h = H::new().await;
    let (art, id) = h.add_outside("s2", "w2-only.md", b"w2 data").await;
    symlink(&art, h.wt1.join("sneak")).unwrap();
    for uri in [
        "/api/worktrees/w1/files/sneak".to_string(),
        format!("/api/worktrees/w1/files/{}", art.to_string_lossy()),
    ] {
        let (st, _, b) = h.get(&uri).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{uri}");
        assert!(!text(&b).contains("w2 data"));
    }
    // its own scope can read it
    let (st, _, _) = h.get(&format!("/api/artifacts/{id}/content")).await;
    assert_eq!(st, StatusCode::OK);
}

// S21: the artifact becomes a hard link of another file after it was recorded.
#[tokio::test]
async fn symlink_to_an_artifact_swapped_for_a_hard_link_is_refused() {
    let h = H::new().await;
    let secret = h.outside.join("secret.txt");
    std::fs::write(&secret, "TOPSECRET").unwrap();
    let (art, _) = h.add_outside("s1", "swapme.md", b"fine").await;
    symlink(&art, h.wt1.join("via-link")).unwrap();
    std::fs::remove_file(&art).unwrap();
    std::fs::hard_link(&secret, &art).unwrap(); // nlink 2, same inode as the secret
    let (st, _, b) = h.get("/api/worktrees/w1/files/via-link").await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(!text(&b).contains("TOPSECRET"));
}

#[tokio::test]
async fn a_symlinked_worktree_root_still_serves_its_files() {
    let h = H::new().await;
    let real = h.tmp.path().join("real-w3");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("a.md"), "via symlinked root").unwrap();
    let link = Paths::with_home(h.home.join(".vibe-station")).worktree_path("p1", "w3");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&real, &link).unwrap();
    h.store
        .mutate_project("p1", |p| {
            p.worktrees.push(worktree("w3", vec![]));
            Ok(p.clone())
        })
        .await
        .unwrap();
    let (st, _, b) = h.get("/api/worktrees/w3/files/a.md").await;
    assert_eq!(
        (st, text(&b).as_str()),
        (StatusCode::OK, "via symlinked root")
    );
    let (st, _, _) = h.get("/api/worktrees/w3/tree").await;
    assert_eq!(st, StatusCode::OK);
}

// ---------------------------------------------------------------- 4.T2b

#[tokio::test]
async fn open_files_accept_absolute_paths_only_for_live_artifacts() {
    let h = H::new().await;
    let secret = h.outside.join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let (art, id) = h.add_outside("s1", "tab.md", b"tab").await;
    let art_s = art.to_string_lossy().to_string();

    // absolute artifact path: 200 and persisted verbatim (absolute)
    let (st, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/open-files",
            Some(json!({ "path": art_s })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["paths"], json!([art_s]));
    // in-repo relative still persists relatively
    wt_file(&h, "docs/r.md", b"r");
    let (_, v) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/open-files",
            Some(json!({ "path": "docs/r.md" })),
        )
        .await;
    assert_eq!(v["paths"], json!([art_s, "docs/r.md"]));

    // S19: absolute non-artifact -> 403, nothing persisted (open + close)
    for method in [Method::POST, Method::DELETE] {
        let (st, _) = h
            .json(
                method,
                "/api/worktrees/w1/open-files",
                Some(json!({ "path": secret.to_string_lossy() })),
            )
            .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }
    let (_, v) = h
        .json(Method::GET, "/api/worktrees/w1/open-files", None)
        .await;
    assert_eq!(v["paths"], json!([art_s, "docs/r.md"]));

    // an artifact of ANOTHER worktree is not an open-file for this one
    let (other, _) = h.add_outside("s2", "w2.md", b"w2").await;
    let (st, _) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/open-files",
            Some(json!({ "path": other.to_string_lossy() })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Remove never edits openFiles; the stored tab stays closable afterwards
    h.json(Method::DELETE, &format!("/api/artifacts/{id}"), None)
        .await;
    let (_, v) = h
        .json(Method::GET, "/api/worktrees/w1/open-files", None)
        .await;
    assert_eq!(v["paths"], json!([art_s, "docs/r.md"]));
    let (st, v) = h
        .json(
            Method::DELETE,
            "/api/worktrees/w1/open-files",
            Some(json!({ "path": art_s })),
        )
        .await;
    assert_eq!(
        (st, v["paths"].clone()),
        (StatusCode::OK, json!(["docs/r.md"]))
    );
    // but a hidden row is no longer a live artifact for a NEW open
    let (st, _) = h
        .json(
            Method::POST,
            "/api/worktrees/w1/open-files",
            Some(json!({ "path": art_s })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn project_open_files_follow_the_same_rule() {
    let h = H::new().await;
    let secret = h.outside.join("secret.txt");
    std::fs::write(&secret, "x").unwrap();
    let (art, _) = h.add_outside("sd1", "ptab.md", b"tab").await;
    let art_s = art.to_string_lossy().to_string();
    let (st, v) = h
        .json(
            Method::POST,
            "/api/projects/p1/open-files",
            Some(json!({ "path": art_s })),
        )
        .await;
    assert_eq!((st, v["paths"].clone()), (StatusCode::OK, json!([art_s])));
    for method in [Method::POST, Method::DELETE] {
        let (st, _) = h
            .json(
                method,
                "/api/projects/p1/open-files",
                Some(json!({ "path": secret.to_string_lossy() })),
            )
            .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }
    let (st, v) = h
        .json(
            Method::DELETE,
            "/api/projects/p1/open-files",
            Some(json!({ "path": art_s })),
        )
        .await;
    assert_eq!((st, v["paths"].clone()), (StatusCode::OK, json!([])));
}

// ---------------------------------------------------------------- 4.T3

#[tokio::test]
async fn worktree_and_project_delete_purge_their_rows_and_hide_keeps_them() {
    let h = H::new().await;
    h.add_outside("s1", "a.md", b"a").await;
    h.add_outside("s2", "b.md", b"b").await;
    h.add_outside("sd1", "c.md", b"c").await;
    let rows = |scope: ScopeKey| {
        let store = h.store.clone();
        async move { store.list_artifacts(&scope).await.unwrap().len() }
    };

    // hide does not purge
    let (st, _) = h
        .json(
            Method::PATCH,
            "/api/worktrees/w1/hide",
            Some(json!({ "hidden": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(rows(ScopeKey::worktree("w1")).await, 1);

    // deleting w1 purges only w1
    let (st, v) = h.json(Method::DELETE, "/api/worktrees/w1", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(rows(ScopeKey::worktree("w1")).await, 0);
    assert_eq!(rows(ScopeKey::worktree("w2")).await, 1);
    assert_eq!(rows(ScopeKey::project("p1")).await, 1);

    // deleting the project purges project + remaining worktree scopes
    let (st, v) = h.json(Method::DELETE, "/api/projects/p1", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(rows(ScopeKey::worktree("w2")).await, 0);
    assert_eq!(rows(ScopeKey::project("p1")).await, 0);
}

// ---------------------------------------------------------------- 4.T4

fn code(result: &Value) -> &str {
    result["error"]["code"].as_str().unwrap_or("")
}

#[tokio::test]
async fn add_denylist_matrix_returns_per_path_errors() {
    let h = H::new().await;
    // the daemon's data home is `<home>/.vibe-station`; `<home>` plays $HOME
    let ssh = h.home.join(".ssh");
    let aws = h.home.join(".aws");
    for d in [&ssh, &aws] {
        std::fs::create_dir_all(d).unwrap();
    }
    let vst = h.home.join(".vibe-station");
    std::fs::create_dir_all(&vst).unwrap();
    let denied: Vec<PathBuf> = vec![
        ssh.join("id_rsa"),
        aws.join("credentials"),
        vst.join("config.json"),
        h.outside.join(".env"),
        h.outside.join("foo.pem"),
        h.outside.join("id_ed25519"),
        h.outside.join("tls.key"),
    ];
    for p in &denied {
        std::fs::write(p, "secret").unwrap();
    }
    let refs: Vec<&Path> = denied.iter().map(|p| p.as_path()).collect();
    let (st, body) = h.add("s1", &refs).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    for (r, p) in body["results"].as_array().unwrap().iter().zip(&denied) {
        assert_eq!(code(r), "ARTIFACT_DENIED", "{}: {r}", p.display());
        assert!(r["artifact"].is_null());
    }
    assert_eq!(h.list("/api/worktrees/w1/artifacts").await["total"], 0);

    // S8: case variants. On a case-insensitive volume they alias the real file
    // and must still be denied; on a case-sensitive one they do not exist.
    let variant = h.home.join(".SSH").join("ID_RSA");
    let (_, body) = h.add("s1", &[&variant]).await;
    let r = &body["results"][0];
    if variant.exists() {
        assert_eq!(code(r), "ARTIFACT_DENIED", "{r}");
    } else {
        assert!(!code(r).is_empty() && r["artifact"].is_null(), "{r}");
    }
}

#[tokio::test]
async fn add_vst_home_only_allows_registered_roots() {
    let h = H::new().await;
    // S9: a file under a registered worktree root is allowed, session data is not
    let doc = wt_file(&h, "docs/a.md", b"doc");
    let sd = h.home.join(".vibe-station/projects/p1/session-data/s1");
    std::fs::create_dir_all(&sd).unwrap();
    let notes = sd.join("notes.md");
    std::fs::write(&notes, "private").unwrap();
    let (st, body) = h.add("s1", &[&doc, &notes]).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let rs = body["results"].as_array().unwrap();
    assert!(rs[0]["artifact"]["id"].is_string(), "{}", rs[0]);
    assert_eq!(rs[0]["artifact"]["inRepo"], true);
    assert_eq!(rs[0]["outsideWorktree"], false);
    assert_eq!(code(&rs[1]), "ARTIFACT_DENIED");
}

#[tokio::test]
async fn add_session_and_validation_errors() {
    let h = H::new().await;
    let f = h.outside.join("x.md");
    std::fs::write(&f, "x").unwrap();

    // S15 unknown / archived session; empty and oversize lists
    let (st, e) = h.add("no-such-session", &[&f]).await;
    assert_eq!(
        (st, e["error"].clone()),
        (StatusCode::NOT_FOUND, json!("NOT_FOUND"))
    );
    let (st, e) = h.add("s-arch", &[&f]).await;
    assert_eq!(
        (st, e["error"].clone()),
        (StatusCode::FORBIDDEN, json!("SESSION_ARCHIVED"))
    );
    let (st, e) = h.add("s1", &[]).await;
    assert_eq!(
        (st, e["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("VALIDATION_ERROR"))
    );
    let many: Vec<PathBuf> = (0..51).map(|i| h.outside.join(format!("m{i}"))).collect();
    let refs: Vec<&Path> = many.iter().map(|p| p.as_path()).collect();
    let (st, _) = h.add("s1", &refs).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.list("/api/worktrees/w1/artifacts").await["total"],
        0,
        "nothing recorded"
    );

    // per-path: relative, NUL, control char, 4 KB+ -> VALIDATION_ERROR; missing -> NOT_FOUND
    let (st, body) = h
        .json(
            Method::POST,
            "/api/artifacts",
            Some(json!({ "spawnToken": "s1", "paths": [
                "relative/a.md",
                "/tmp/nul\u{0}byte",
                "/tmp/ctl\u{7}char",
                format!("/tmp/{}", "a".repeat(5000)),
                h.outside.join("missing.md").to_string_lossy(),
            ]})),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let rs = body["results"].as_array().unwrap();
    for r in &rs[..4] {
        assert_eq!(code(r), "VALIDATION_ERROR", "{r}");
    }
    assert_eq!(code(&rs[4]), "NOT_FOUND");
}

#[tokio::test]
async fn add_ineligible_paths() {
    let h = H::new().await;
    // in-repo source file, a directory, a FIFO
    let src = wt_file(&h, "src/main.rs", b"fn main(){}");
    let dir = h.outside.join("adir");
    std::fs::create_dir_all(&dir).unwrap();
    let fifo = h.outside.join("pipe");
    let made = std::process::Command::new("mkfifo").arg(&fifo).status();
    let (st, body) = h.add("s1", &[&src, &dir]).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    for r in body["results"].as_array().unwrap() {
        assert_eq!(code(r), "ARTIFACT_INELIGIBLE", "{r}");
    }
    if made.map(|s| s.success()).unwrap_or(false) {
        // must return (never block on open) and refuse
        let (st, body) = tokio::time::timeout(Duration::from_secs(5), h.add("s1", &[&fifo]))
            .await
            .expect("a FIFO must not hang the add");
        assert_eq!(st, StatusCode::OK);
        assert_eq!(code(&body["results"][0]), "ARTIFACT_INELIGIBLE", "{body}");
    }
    assert_eq!(h.list("/api/worktrees/w1/artifacts").await["total"], 0);
}

#[tokio::test]
async fn add_is_rate_limited_per_request_not_per_path() {
    let h = H::new().await;
    // 20 paths in ONE request cost one token
    let many: Vec<PathBuf> = (0..20)
        .map(|i| {
            let p = h.outside.join(format!("n{i}.md"));
            std::fs::write(&p, format!("{i}")).unwrap();
            p
        })
        .collect();
    let refs: Vec<&Path> = many.iter().map(|p| p.as_path()).collect();
    let (st, body) = h.add("s-batch", &refs).await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["results"].as_array().unwrap().len(), 20);
    assert!(body["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["artifact"]["id"].is_string()));

    // S16: a flood of 100 requests in ~1 s hits 429 after the burst
    let f = h.outside.join("flood.md");
    std::fs::write(&f, "x").unwrap();
    let mut ok = 0;
    let mut limited = 0;
    for _ in 0..100 {
        let (st, e) = h.add("s-rate", &[&f]).await;
        match st {
            StatusCode::OK => ok += 1,
            StatusCode::TOO_MANY_REQUESTS => {
                assert_eq!(e["error"], "RATE_LIMITED");
                limited += 1;
            }
            other => panic!("unexpected {other}"),
        }
    }
    assert!(
        (10..=13).contains(&ok),
        "burst of 10 (+ refill during the loop): {ok}"
    );
    assert_eq!(ok + limited, 100);
    // another session is unaffected
    let (st, _) = h.add("s1", &[&f]).await;
    assert_eq!(st, StatusCode::OK);
}

// ---------------------------------------------------------------- 4.T6

#[tokio::test]
async fn sink_effect_reaches_the_broadcaster_as_artifact_upserted() {
    let h = H::new().await;
    let task = h.state.artifacts.start();
    let mut rx = h.broadcaster.subscribe();
    let f = h.outside.join("e2e.md");
    std::fs::write(&f, "from the sink").unwrap();

    let started = Instant::now();
    h.state.artifacts.record(
        WriteContext {
            project_id: "p1".into(),
            worktree_id: Some("w1".into()),
            session_id: "s1".into(),
            cwd: h.wt1.clone(),
        },
        vec![FileEffect::write(f.to_string_lossy())],
    );
    let event = tokio::time::timeout(Duration::from_millis(400), async {
        loop {
            match rx.recv().await {
                Ok(e @ ServerEvent::ArtifactUpserted { .. }) => return e,
                Ok(_) => continue,
                Err(e) => panic!("broadcaster closed: {e}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "no artifact:upserted within 400 ms ({:?})",
            started.elapsed()
        )
    });
    task.abort();

    let ServerEvent::ArtifactUpserted {
        scope_id,
        rows,
        rev,
        ..
    } = event
    else {
        unreachable!()
    };
    assert_eq!(scope_id, "w1");
    assert!(rev >= 1);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].created);
    assert!(rows[0].row.path.ends_with("e2e.md"));
    // and the list agrees (rev already covers the event)
    let v = h.list("/api/worktrees/w1/artifacts").await;
    assert_eq!(v["items"][0]["path"], rows[0].row.path.as_str());
}
