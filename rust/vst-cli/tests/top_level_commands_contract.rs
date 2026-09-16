//! Behavior-contract tests for vst-cli top-level standalone commands (dispatch #4).
//!
//! ## Behavior contract
//!
//! ### `vst doctor`
//! - `parse_doctor_options` accepts no flags and rejects unknown flags.
//! - `trim_trailing_dot` removes a single trailing `.` from a DNS name.
//! - `parse_proxy_port` extracts the numeric port from a `https://host:PORT/...`
//!   proxy URL; falls back to 443 for `https:` (and 80 for `http:`) when no port
//!   is present; returns `None` for unparseable URLs.
//! - `find_serve_port` scans `config.web` entries whose key ends in `:443`, reads
//!   `handlers["/"].proxy`, and returns the parsed proxy port; `None` when no such
//!   rule exists.
//! - `get_daemon_port_from_config` reads `<home>/.vibe-station/config.json`'s
//!   `port` when it is a positive number; `None` otherwise (missing file, bad
//!   JSON, non-number, or non-positive).
//! - `check` runs a closure and prints a ✓ (true) or ✗ (false) line, returning
//!   the closure's result.
//!
//! ### `vst summary`
//! - `parse_summary_options` parses `--json` and `--project <id>`.
//! - `glyph_for_state` returns a distinct glyph for each lifecycle state
//!   (working/idle/not_started/done/exited/other).
//! - `build_summary_json(worktrees, sessions)` groups sessions onto their
//!   worktree and produces `{ generatedAt, worktrees: [{ id, branch, sessions:
//!   [{ id, isMain, state, type, lastTransitionAt }] }] }`; sessions whose
//!   worktreeId matches no listed worktree are dropped.
//!
//! ### `vst open`
//! - `parse_open_options` accepts zero or one positional path and rejects
//!   unknown flags.
//! - `resolve_path` turns a relative path into an absolute path (falling back to
//!   cwd when the target doesn't canonicalize).
//! - `post_open_at` POSTs `{ path }` to `/open`, returning the project id; a
//!   non-2xx response is an `OpenFailure::Http` carrying the server's error
//!   message.
//! - `poll_for_daemon_at` returns true as soon as `/health` responds ok, false
//!   once the timeout elapses.
//!
//! ### `vst status`
//! - `parse_status_options` parses `--project <id>` and `--json`.
//! - `state_icon` returns a distinct glyph for idle/running/error/other states.
//! - `run_status` fetches `GET /sessions[?project=<id>]` and prints JSON or text.

use axum::extract::{Json, Query};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use vst_cli::commands::doctor::{
    find_serve_port, get_daemon_port_from_config, parse_doctor_options, parse_proxy_port,
    trim_trailing_dot, TailscaleServeJson,
};
use vst_cli::commands::open::{parse_open_options, post_open_at, resolve_path};
use vst_cli::commands::status::{parse_status_options, state_icon};
use vst_cli::commands::summary::{build_summary_json, glyph_for_state, parse_summary_options};
use vst_types::domain::{LifecycleState, SessionType};
use vst_types::rest::sessions::SessionOrDraft;
use vst_types::rest::shared::Worktree;

// ─── doctor option parsing ────────────────────────────────────────────────────

#[test]
fn test_doctor_parses_no_args() {
    let opts = parse_doctor_options(&[]).expect("parse empty ok");
    assert_eq!(opts, vst_cli::commands::doctor::DoctorOptions);
}

#[test]
fn test_doctor_rejects_unknown_flag() {
    let err = parse_doctor_options(&["--json".to_string()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err was: {err}");
}

// ─── doctor helpers ───────────────────────────────────────────────────────────

#[test]
fn test_trim_trailing_dot_removes_one_dot() {
    assert_eq!(trim_trailing_dot("host.example.com."), "host.example.com");
    assert_eq!(trim_trailing_dot("host.example.com"), "host.example.com");
    assert_eq!(trim_trailing_dot(""), "");
}

#[test]
fn test_parse_proxy_port_explicit() {
    assert_eq!(parse_proxy_port("https://example.com:8443/"), Some(8443));
    assert_eq!(parse_proxy_port("http://example.com:8080/"), Some(8080));
}

#[test]
fn test_parse_proxy_port_default_scheme() {
    assert_eq!(parse_proxy_port("https://example.com/"), Some(443));
    assert_eq!(parse_proxy_port("http://example.com/"), Some(80));
}

#[test]
fn test_parse_proxy_port_invalid() {
    assert_eq!(parse_proxy_port("not a url"), None);
    assert_eq!(parse_proxy_port(""), None);
}

#[test]
fn test_find_serve_port_matches_443_rule() {
    let serve = TailscaleServeJson {
        web: Some(HashMap::from([(
            "example.com:443".to_string(),
            vst_cli::commands::doctor::TailscaleWebEntry {
                handlers: Some(HashMap::from([(
                    "/".to_string(),
                    vst_cli::commands::doctor::TailscaleHandler {
                        proxy: Some("https://127.0.0.1:7421".to_string()),
                    },
                )])),
            },
        )])),
    };
    assert_eq!(find_serve_port(Some(&serve)), Some(7421));
}

#[test]
fn test_find_serve_port_ignores_non_443_keys() {
    let serve = TailscaleServeJson {
        web: Some(HashMap::from([(
            "example.com:8080".to_string(),
            vst_cli::commands::doctor::TailscaleWebEntry {
                handlers: Some(HashMap::from([(
                    "/".to_string(),
                    vst_cli::commands::doctor::TailscaleHandler {
                        proxy: Some("https://127.0.0.1:8080".to_string()),
                    },
                )])),
            },
        )])),
    };
    assert_eq!(find_serve_port(Some(&serve)), None);
}

#[test]
fn test_find_serve_port_ignores_missing_proxy() {
    let serve = TailscaleServeJson {
        web: Some(HashMap::from([(
            "example.com:443".to_string(),
            vst_cli::commands::doctor::TailscaleWebEntry { handlers: None },
        )])),
    };
    assert_eq!(find_serve_port(Some(&serve)), None);
    assert_eq!(find_serve_port(None), None);
}

#[test]
fn test_get_daemon_port_from_config_reads_valid_port() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg_dir = dir.path().join(".vibe-station");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir");
    std::fs::write(cfg_dir.join("config.json"), r#"{"port": 7421}"#).expect("write");
    assert_eq!(get_daemon_port_from_config(Some(dir.path())), Some(7421));
}

#[test]
fn test_get_daemon_port_from_config_ignores_non_positive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg_dir = dir.path().join(".vibe-station");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir");
    std::fs::write(cfg_dir.join("config.json"), r#"{"port": 0}"#).expect("write");
    assert_eq!(get_daemon_port_from_config(Some(dir.path())), None);
}

#[test]
fn test_get_daemon_port_from_config_missing_or_bad() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(get_daemon_port_from_config(Some(dir.path())), None);

    let cfg_dir = dir.path().join(".vibe-station");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir");
    std::fs::write(cfg_dir.join("config.json"), "not json").expect("write");
    assert_eq!(get_daemon_port_from_config(Some(dir.path())), None);

    std::fs::write(cfg_dir.join("config.json"), r#"{"port": "oops"}"#).expect("write");
    assert_eq!(get_daemon_port_from_config(Some(dir.path())), None);
}

// ─── summary option parsing ───────────────────────────────────────────────────

#[test]
fn test_summary_parses_json_and_project() {
    let opts = parse_summary_options(&["--json".into(), "--project".into(), "p1".into()])
        .expect("parse ok");
    assert!(opts.json);
    assert_eq!(opts.project.as_deref(), Some("p1"));
}

#[test]
fn test_summary_defaults() {
    let opts = parse_summary_options(&[]).expect("parse empty ok");
    assert!(!opts.json);
    assert!(opts.project.is_none());
}

#[test]
fn test_summary_rejects_unknown_flag() {
    let err = parse_summary_options(&["--foo".into()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err was: {err}");
}

// ─── summary glyphs ───────────────────────────────────────────────────────────

#[test]
fn test_summary_glyph_for_each_state_is_nonempty() {
    assert!(!glyph_for_state(&LifecycleState::Working).is_empty());
    assert!(!glyph_for_state(&LifecycleState::Idle).is_empty());
    assert!(!glyph_for_state(&LifecycleState::NotStarted).is_empty());
    assert!(!glyph_for_state(&LifecycleState::Done).is_empty());
    assert!(!glyph_for_state(&LifecycleState::Exited).is_empty());
    assert!(!glyph_for_state(&LifecycleState::WaitingForHuman).is_empty());
}

// ─── summary build_json ───────────────────────────────────────────────────────

fn sample_worktree(id: &str, project: &str, branch: &str) -> Worktree {
    Worktree {
        id: id.to_string(),
        project_id: project.to_string(),
        name: None,
        branch: branch.to_string(),
        branch_is_placeholder: false,
        base_branch: "main".to_string(),
        base_sha: "abc".to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        main_session_id: None,
    }
}

fn session(id: &str, worktree: &str, is_main: bool, state: LifecycleState) -> SessionOrDraft {
    SessionOrDraft::Session(vst_types::rest::shared::Session {
        id: id.to_string(),
        worktree_id: Some(worktree.to_string()),
        project_id: "p1".to_string(),
        is_main,
        r#type: SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("s-{id}"),
        use_tmux: false,
        channel: vst_types::domain::Channel::Json,
        state: state,
        lifecycle_state: state,
        created_at: "2024-02-01T00:00:00Z".to_string(),
        pinned_at: None,
        archived_at: None,
        sort_order: 1.0,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
    })
}

#[test]
fn test_summary_build_json_groups_by_worktree() {
    let worktrees = vec![sample_worktree("wt-1", "p1", "main")];
    let sessions = vec![
        session("s-1", "wt-1", true, LifecycleState::Working),
        session("s-2", "wt-1", false, LifecycleState::Idle),
    ];
    let value = build_summary_json(&worktrees, &sessions);
    let arr = value["worktrees"].as_array().expect("worktrees array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], json!("wt-1"));
    assert_eq!(arr[0]["branch"], json!("main"));
    let sess = arr[0]["sessions"].as_array().expect("sessions array");
    assert_eq!(sess.len(), 2);
    assert_eq!(sess[0]["id"], json!("s-1"));
    assert_eq!(sess[0]["isMain"], json!(true));
    assert_eq!(sess[0]["state"], json!("working"));
    assert_eq!(sess[0]["type"], json!("agent"));
    assert_eq!(sess[0]["lastTransitionAt"], json!("2024-02-01T00:00:00Z"));
    assert!(value["generatedAt"].is_string());
}

#[test]
fn test_summary_build_json_drops_unmatched_sessions() {
    let worktrees = vec![sample_worktree("wt-1", "p1", "main")];
    let sessions = vec![session("s-orphan", "wt-NOPE", false, LifecycleState::Idle)];
    let value = build_summary_json(&worktrees, &sessions);
    let sess = value["worktrees"][0]["sessions"]
        .as_array()
        .expect("sessions");
    assert_eq!(sess.len(), 0);
}

#[test]
fn test_summary_build_json_empty_worktrees() {
    let value = build_summary_json(&[], &[]);
    let arr = value["worktrees"].as_array().expect("worktrees array");
    assert_eq!(arr.len(), 0);
}

// ─── status option parsing ────────────────────────────────────────────────────

#[test]
fn test_status_parses_project_and_json() {
    let opts = parse_status_options(&["--project".into(), "p1".into(), "--json".into()])
        .expect("parse ok");
    assert_eq!(opts.project.as_deref(), Some("p1"));
    assert!(opts.json);
}

#[test]
fn test_status_defaults() {
    let opts = parse_status_options(&[]).expect("parse empty ok");
    assert!(opts.project.is_none());
    assert!(!opts.json);
}

#[test]
fn test_status_rejects_unknown_flag() {
    let err = parse_status_options(&["--foo".into()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err was: {err}");
}

// ─── status state icons ───────────────────────────────────────────────────────

#[test]
fn test_status_icon_distinct_for_states() {
    assert!(!state_icon(&LifecycleState::Idle).is_empty());
    assert!(!state_icon(&LifecycleState::Working).is_empty());
    assert!(!state_icon(&LifecycleState::Done).is_empty());
    assert!(!state_icon(&LifecycleState::WaitingForHuman).is_empty());
}

// ─── open option parsing ──────────────────────────────────────────────────────

#[test]
fn test_open_parses_no_path() {
    let opts = parse_open_options(&[]).expect("parse empty ok");
    assert_eq!(opts.path, None);
}

#[test]
fn test_open_parses_one_path() {
    let opts = parse_open_options(&["/some/dir".into()]).expect("parse ok");
    assert_eq!(opts.path.as_deref(), Some("/some/dir"));
}

#[test]
fn test_open_rejects_unknown_flag() {
    let err = parse_open_options(&["--foo".into()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err was: {err}");
}

#[test]
fn test_open_resolve_path_defaults_to_cwd() {
    let cwd = std::env::current_dir().expect("cwd");
    let abs = resolve_path(None);
    let cwd_str = cwd.to_string_lossy().to_string();
    assert!(abs.starts_with(&cwd_str), "abs: {abs}, cwd: {cwd_str}");
    assert!(
        Path::new(&abs).is_absolute(),
        "abs should be absolute: {abs}"
    );
}

#[test]
fn test_open_resolve_path_absolute_unchanged() {
    let abs = resolve_path(Some("/tmp/definitely-absolute-dir"));
    assert!(abs.starts_with('/'), "abs: {abs}");
}

// ─── mock server helper ───────────────────────────────────────────────────────

async fn spawn_mock_server(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    addr
}

// ─── open POST endpoint (mock server) ─────────────────────────────────────────

#[tokio::test]
async fn test_post_open_success_returns_project_id() {
    use axum::extract::Json as AxumJson;
    use axum::routing::post;
    use serde_json::Value;

    let router = Router::new().route(
        "/open",
        post(|AxumJson(body): AxumJson<Value>| async move {
            let path = body["path"].as_str().expect("path field");
            assert!(path.starts_with('/'), "should be absolute: {path}");
            (StatusCode::OK, Json(json!({ "projectId": "proj-abc" })))
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base = format!("http://{addr}");

    let result = post_open_at(&base, None, "/abs/path").await;
    let project_id = match result {
        Ok(id) => id,
        Err(e) => panic!("expected Ok, got {e:?}"),
    };
    assert_eq!(project_id, "proj-abc");
}

#[tokio::test]
async fn test_post_open_error_surfaces_server_message() {
    use axum::extract::Json as AxumJson;
    use axum::routing::post;
    use serde_json::Value;
    use vst_cli::commands::open::OpenFailure;

    let router = Router::new().route(
        "/open",
        post(|AxumJson(_): AxumJson<Value>| async {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad path" })),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base = format!("http://{addr}");

    let result = post_open_at(&base, None, "/abs/path").await;
    let Err(failure) = result else {
        panic!("expected Err, got Ok");
    };
    if let OpenFailure::Http { status, message } = failure {
        assert_eq!(status, 400);
        assert_eq!(message, "bad path");
    } else {
        panic!("expected Http failure, got {failure:?}");
    }
}

// ─── poll for daemon (mock server) ────────────────────────────────────────────

#[tokio::test]
async fn test_poll_for_daemon_returns_true_when_ready() {
    let router = Router::new().route(
        "/health",
        get(|| async {
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "version": "1.0.0",
                    "port": 7421,
                    "uptime": 5
                })),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base = format!("http://{addr}");

    let ready =
        vst_cli::commands::open::poll_for_daemon_at(&base, Duration::from_millis(500)).await;
    assert!(ready, "should detect running daemon");
}

#[tokio::test]
async fn test_poll_for_daemon_times_out_when_unreachable() {
    // Bind a listener then drop it so the port is guaranteed free, then poll a
    // short time — the request fails and poll returns false.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    drop(listener);
    let base = format!("http://{addr}");

    let ready =
        vst_cli::commands::open::poll_for_daemon_at(&base, Duration::from_millis(300)).await;
    assert!(!ready, "should time out on unreachable daemon");
}

// ─── status HTTP layer (mock server) ──────────────────────────────────────────

#[tokio::test]
async fn test_status_sessions_query() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::sessions::SessionOrDraft;

    let router = Router::new().route(
        "/sessions",
        get(|Query(params): Query<HashMap<String, String>>| async move {
            let project = params.get("project").cloned().unwrap_or_default();
            assert_eq!(project, "p1");
            (
                StatusCode::OK,
                Json(json!([
                    {
                        "id": "s-1",
                        "worktreeId": "wt-1",
                        "projectId": "p1",
                        "isMain": true,
                        "type": "agent",
                        "modeId": null,
                        "name": null,
                        "nameSource": null,
                        "tmuxName": "s-s-1",
                        "useTmux": false,
                        "channel": "json",
                        "state": "idle",
                        "lifecycleState": "idle",
                        "createdAt": "2024-01-01T00:00:00Z",
                        "pinnedAt": null,
                        "archivedAt": null,
                        "sortOrder": 1.0,
                        "handoffSummary": null,
                        "parentSessionId": null,
                        "supersededBy": null,
                        "pr": null,
                        "draftPrompt": null,
                        "draftConfig": null
                    }
                ])),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base = format!("http://{addr}");

    let result = daemon_request_with_base::<Vec<SessionOrDraft>, ()>(
        &base,
        None,
        Method::GET,
        "/sessions?project=p1",
        None,
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
    if let vst_cli::client::DaemonResult::Ok { data, .. } = result {
        assert_eq!(data.len(), 1);
        if let SessionOrDraft::Session(s) = &data[0] {
            assert_eq!(s.id, "s-1");
            assert_eq!(s.state, LifecycleState::Idle);
        } else {
            panic!("expected Session variant");
        }
    } else {
        panic!("expected DaemonResult::Ok");
    }
}

// ─── summary HTTP layer (mock server) ─────────────────────────────────────────

#[tokio::test]
async fn test_summary_fetches_worktrees_and_sessions() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::sessions::SessionOrDraft;
    use vst_types::rest::shared::Worktree;

    let router = Router::new()
        .route(
            "/worktrees",
            get(|| async {
                (
                    StatusCode::OK,
                    Json(json!([{
                        "id": "wt-1",
                        "projectId": "p1",
                        "name": null,
                        "branch": "main",
                        "branchIsPlaceholder": false,
                        "baseBranch": "main",
                        "baseSha": "abc",
                        "createdAt": "2024-01-01T00:00:00Z",
                        "pinnedAt": null,
                        "hiddenAt": null,
                        "sortOrder": 1.0,
                        "mainSessionId": null
                    }])),
                )
            }),
        )
        .route(
            "/sessions",
            get(|| async {
                (
                    StatusCode::OK,
                    Json(json!([
                        {
                            "id": "s-1",
                            "worktreeId": "wt-1",
                            "projectId": "p1",
                            "isMain": true,
                            "type": "agent",
                            "modeId": null,
                            "name": null,
                            "nameSource": null,
                            "tmuxName": "s-s-1",
                            "useTmux": false,
                            "channel": "json",
                            "state": "working",
                            "lifecycleState": "working",
                            "createdAt": "2024-02-01T00:00:00Z",
                            "pinnedAt": null,
                            "archivedAt": null,
                            "sortOrder": 1.0,
                            "handoffSummary": null,
                            "parentSessionId": null,
                            "supersededBy": null,
                            "pr": null,
                            "draftPrompt": null,
                            "draftConfig": null
                        }
                    ])),
                )
            }),
        );

    let addr = spawn_mock_server(router).await;
    let base = format!("http://{addr}");

    let wt =
        daemon_request_with_base::<Vec<Worktree>, ()>(&base, None, Method::GET, "/worktrees", None)
            .await
            .expect("worktrees ok");
    let sess = daemon_request_with_base::<Vec<SessionOrDraft>, ()>(
        &base,
        None,
        Method::GET,
        "/sessions",
        None,
    )
    .await
    .expect("sessions ok");

    assert!(wt.is_ok());
    assert!(sess.is_ok());

    if let vst_cli::client::DaemonResult::Ok { data, .. } = wt {
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].id, "wt-1");
    } else {
        panic!("expected worktrees Ok");
    }
    if let vst_cli::client::DaemonResult::Ok { data, .. } = sess {
        assert_eq!(data.len(), 1);
    } else {
        panic!("expected sessions Ok");
    }
}
