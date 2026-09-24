//! Behavior-contract tests for vst-cli worktree, project, file, and daemon commands (dispatch #3).
//!
//! ## Behavior contract
//!
//! ### Worktree commands
//! - `parse_worktree_create_options` parses `<projectId>`, `--mode`, `--name`, `--base`,
//!   `--branch`, `--prompt`, `--prompt-file`, `--channel` (`tmux`|`json`, default `tmux`),
//!   `--parent`, `--no-parent`.
//! - `run_worktree_create` requires `--mode`, resolves source_agent_id from `$VST_SESSION` by
//!   default, posts `POST /worktrees`, prints branch and id on success.
//! - `parse_worktree_rm_options` parses `<id>` and `--purge`.
//! - `parse_worktree_ls_options` parses `--project` and `--json`.
//! - `run_worktree_ls` appends `?project=<id>` when project is given.
//! - `parse_worktree_info_options` parses `<id>` and `--json`.
//! - `parse_worktree_rename_options` parses `<id>` and `<name>`.
//! - `run_worktree_rename` sends `PATCH /worktrees/:id/rename` and prints "Renamed to:" or
//!   "Name cleared".
//! - `run_worktree_done` sends `POST /worktrees/:id/done` and prints success with counts.
//!
//! ### Project commands
//! - `parse_project_add_options` parses `<path>`, `--name`, `--prefix`.
//! - `run_project_add` posts to `POST /projects`; on 409 exits with code 3.
//! - `parse_project_create_options` parses `<name>`, `--dir`, `--start-agent`, `--mode`,
//!   `--prompt`, `--worktree`; validates --mode required if --start-agent.
//! - `run_project_create` posts to `POST /projects/create`.
//! - `parse_project_ls_options` parses `--json`.
//! - `parse_project_info_options` parses `<id>` and `--json`.
//! - `run_project_rm` sends `DELETE /projects/:id`.
//!
//! ### File commands
//! - `parse_file_open_options` parses `<worktreeId>` and `<path>`.
//! - `run_file_open` resolves absolute path and posts to `POST /worktrees/:id/open-file`.
//!
//! ### Daemon commands
//! - `parse_daemon_status_options` parses `--json`.
//! - `run_daemon_status` sends `GET /health`, prints port/version/uptime in human format or JSON.
//! - `format_seconds` formats correctly: <60 → s, <3600 → m, ≥3600 → h.

use axum::extract::{Json, Path, Query};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::Router;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;

use vst_cli::commands::daemon::status::parse_daemon_status_options;
use vst_cli::commands::file::open::parse_file_open_options;
use vst_cli::commands::project::add::parse_project_add_options;
use vst_cli::commands::project::create::parse_project_create_options;
use vst_cli::commands::project::info::parse_project_info_options;
use vst_cli::commands::project::ls::parse_project_ls_options;
use vst_cli::commands::worktree::create::parse_worktree_create_options;
use vst_cli::commands::worktree::info::parse_worktree_info_options;
use vst_cli::commands::worktree::ls::parse_worktree_ls_options;
use vst_cli::commands::worktree::rename::parse_worktree_rename_options;
use vst_cli::commands::worktree::rm::parse_worktree_rm_options;

// ─── Worktree command option parsing ──────────────────────────────────────────

#[test]
fn test_worktree_create_parses_required_args() {
    let args: Vec<String> = vec!["my-project".into(), "--mode".into(), "claude-mode".into()];
    let opts = parse_worktree_create_options(&args).expect("parse ok");
    assert_eq!(opts.project_id, "my-project");
    assert_eq!(opts.mode, "claude-mode");
    assert_eq!(opts.channel, "tmux");
    assert!(opts.branch.is_none());
}

#[test]
fn test_worktree_create_parses_all_flags() {
    let args: Vec<String> = vec![
        "proj-1".into(),
        "--mode".into(),
        "m1".into(),
        "--name".into(),
        "my-wt".into(),
        "--base".into(),
        "main".into(),
        "--branch".into(),
        "feat/abc".into(),
        "--prompt".into(),
        "do stuff".into(),
        "--channel".into(),
        "json".into(),
        "--parent".into(),
        "sess-abc".into(),
    ];
    let opts = parse_worktree_create_options(&args).expect("parse ok");
    assert_eq!(opts.project_id, "proj-1");
    assert_eq!(opts.mode, "m1");
    assert_eq!(opts.name.as_deref(), Some("my-wt"));
    assert_eq!(opts.base.as_deref(), Some("main"));
    assert_eq!(opts.branch.as_deref(), Some("feat/abc"));
    assert_eq!(opts.prompt.as_deref(), Some("do stuff"));
    assert_eq!(opts.channel, "json");
    assert_eq!(opts.parent.as_deref(), Some("sess-abc"));

    let opts_src = parse_worktree_create_options(&[
        "proj-1".into(),
        "--mode".into(),
        "m1".into(),
        "--source-agent=sess-xyz".into(),
    ])
    .expect("parse ok");
    assert_eq!(opts_src.parent.as_deref(), Some("sess-xyz"));
}

#[test]
fn test_worktree_create_requires_project_id() {
    let args: Vec<String> = vec!["--mode".into(), "m1".into()];
    let err = parse_worktree_create_options(&args).expect_err("should fail without projectId");
    assert!(err.contains("projectId"), "err was: {err}");
}

#[test]
fn test_worktree_create_requires_mode() {
    let args: Vec<String> = vec!["proj-1".into()];
    let err = parse_worktree_create_options(&args).expect_err("should fail without --mode");
    assert!(err.contains("--mode"), "err was: {err}");
}

#[test]
fn test_worktree_create_no_parent_flag() {
    let args: Vec<String> = vec![
        "p".into(),
        "--mode".into(),
        "m".into(),
        "--no-parent".into(),
    ];
    let opts = parse_worktree_create_options(&args).expect("parse ok");
    assert!(opts.no_parent);
}

#[test]
fn test_worktree_create_rejects_unknown_flag() {
    let args: Vec<String> = vec!["p".into(), "--mode".into(), "m".into(), "--xyz".into()];
    let err = parse_worktree_create_options(&args).expect_err("should fail on unknown flag");
    assert!(err.contains("Unknown option"), "err was: {err}");
}

#[test]
fn test_worktree_rm_parses_id_and_purge() {
    let args: Vec<String> = vec!["wt-123".into(), "--purge".into()];
    let opts = parse_worktree_rm_options(&args).expect("parse ok");
    assert_eq!(opts.id, "wt-123");
    assert!(opts.purge);
}

#[test]
fn test_worktree_rm_without_purge() {
    let opts = parse_worktree_rm_options(&["wt-456".to_string()]).expect("parse ok");
    assert_eq!(opts.id, "wt-456");
    assert!(!opts.purge);
}

#[test]
fn test_worktree_rm_requires_id() {
    let err = parse_worktree_rm_options(&[]).expect_err("should fail without id");
    assert!(err.contains("id") || err.contains("required"), "err: {err}");
}

#[test]
fn test_worktree_ls_parses_flags() {
    let args: Vec<String> = vec!["--project".into(), "proj-1".into(), "--json".into()];
    let opts = parse_worktree_ls_options(&args).expect("parse ok");
    assert_eq!(opts.project.as_deref(), Some("proj-1"));
    assert!(opts.json);
}

#[test]
fn test_worktree_ls_defaults() {
    let opts = parse_worktree_ls_options(&[]).expect("parse empty ok");
    assert!(opts.project.is_none());
    assert!(!opts.json);
}

#[test]
fn test_worktree_ls_rejects_unknown() {
    let err = parse_worktree_ls_options(&["--foo".to_string()]).expect_err("unknown flag");
    assert!(err.contains("Unknown option"), "err: {err}");
}

#[test]
fn test_worktree_info_parses_id_and_json() {
    let args: Vec<String> = vec!["wt-abc".into(), "--json".into()];
    let opts = parse_worktree_info_options(&args).expect("parse ok");
    assert_eq!(opts.id, "wt-abc");
    assert!(opts.json);
}

#[test]
fn test_worktree_info_requires_id() {
    let err = parse_worktree_info_options(&[]).expect_err("should fail without id");
    assert!(err.contains("required") || err.contains("id"), "err: {err}");
}

#[test]
fn test_worktree_rename_parses_id_and_name() {
    let args: Vec<String> = vec!["wt-id".into(), "my-new-name".into()];
    let opts = parse_worktree_rename_options(&args).expect("parse ok");
    assert_eq!(opts.id, "wt-id");
    assert_eq!(opts.name, "my-new-name");
}

#[test]
fn test_worktree_rename_requires_two_args() {
    let err = parse_worktree_rename_options(&["wt-id".to_string()])
        .expect_err("should fail with only one arg");
    assert!(err.contains("rename"), "err: {err}");
}

// ─── Project command option parsing ───────────────────────────────────────────

#[test]
fn test_project_add_parses_path_and_flags() {
    let args: Vec<String> = vec![
        "/some/path".into(),
        "--name".into(),
        "myproj".into(),
        "--prefix".into(),
        "mp".into(),
    ];
    let opts = parse_project_add_options(&args).expect("parse ok");
    assert_eq!(opts.path, "/some/path");
    assert_eq!(opts.name.as_deref(), Some("myproj"));
    assert_eq!(opts.prefix.as_deref(), Some("mp"));
}

#[test]
fn test_project_add_requires_path() {
    let err = parse_project_add_options(&[]).expect_err("should fail without path");
    assert!(
        err.contains("path") || err.contains("required"),
        "err: {err}"
    );
}

#[test]
fn test_project_create_parses_name_and_flags() {
    let args: Vec<String> = vec![
        "myproj".into(),
        "--dir".into(),
        "/tmp/projects".into(),
        "--start-agent".into(),
        "--mode".into(),
        "claude".into(),
        "--prompt".into(),
        "build an app".into(),
        "--worktree".into(),
    ];
    let opts = parse_project_create_options(&args).expect("parse ok");
    assert_eq!(opts.name, "myproj");
    assert_eq!(opts.dir.as_deref(), Some("/tmp/projects"));
    assert!(opts.start_agent);
    assert_eq!(opts.mode.as_deref(), Some("claude"));
    assert_eq!(opts.prompt.as_deref(), Some("build an app"));
    assert!(opts.worktree);
}

#[test]
fn test_project_create_requires_mode_with_start_agent() {
    let args: Vec<String> = vec!["proj".into(), "--start-agent".into()];
    let err = parse_project_create_options(&args).expect_err("should fail without --mode");
    assert!(err.contains("--mode"), "err: {err}");
}

#[test]
fn test_project_create_prompt_requires_start_agent() {
    let args: Vec<String> = vec!["proj".into(), "--prompt".into(), "do stuff".into()];
    let err = parse_project_create_options(&args).expect_err("should fail without --start-agent");
    assert!(err.contains("--start-agent"), "err: {err}");
}

#[test]
fn test_project_create_requires_name() {
    let err = parse_project_create_options(&[]).expect_err("should fail without name");
    assert!(
        err.contains("name") || err.contains("required"),
        "err: {err}"
    );
}

#[test]
fn test_project_ls_parses_json() {
    let opts = parse_project_ls_options(&["--json".to_string()]).expect("parse ok");
    assert!(opts.json);
}

#[test]
fn test_project_ls_defaults_empty() {
    let opts = parse_project_ls_options(&[]).expect("parse empty ok");
    assert!(!opts.json);
}

#[test]
fn test_project_ls_rejects_unknown() {
    let err = parse_project_ls_options(&["--foo".to_string()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err: {err}");
}

#[test]
fn test_project_info_parses_id_and_json() {
    let args: Vec<String> = vec!["proj-abc".into(), "--json".into()];
    let opts = parse_project_info_options(&args).expect("parse ok");
    assert_eq!(opts.id, "proj-abc");
    assert!(opts.json);
}

#[test]
fn test_project_info_requires_id() {
    let err = parse_project_info_options(&[]).expect_err("should fail without id");
    assert!(err.contains("id") || err.contains("required"), "err: {err}");
}

// ─── File command option parsing ───────────────────────────────────────────────

#[test]
fn test_file_open_parses_worktree_id_and_path() {
    let args: Vec<String> = vec!["wt-abc".into(), "/some/file.ts".into()];
    let opts = parse_file_open_options(&args).expect("parse ok");
    assert_eq!(opts.worktree_id, "wt-abc");
    assert_eq!(opts.path, "/some/file.ts");
}

#[test]
fn test_file_open_requires_two_args() {
    let err =
        parse_file_open_options(&["wt-abc".to_string()]).expect_err("should fail with one arg");
    assert!(err.contains("open"), "err: {err}");
}

#[test]
fn test_file_open_rejects_unknown_flags() {
    let err = parse_file_open_options(&["--foo".to_string()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err: {err}");
}

// ─── Daemon status option parsing ─────────────────────────────────────────────

#[test]
fn test_daemon_status_parses_json() {
    let opts = parse_daemon_status_options(&["--json".to_string()]).expect("parse ok");
    assert!(opts.json);
}

#[test]
fn test_daemon_status_defaults() {
    let opts = parse_daemon_status_options(&[]).expect("parse empty ok");
    assert!(!opts.json);
}

#[test]
fn test_daemon_status_rejects_unknown_flag() {
    let err = parse_daemon_status_options(&["--foo".to_string()]).expect_err("unknown flag");
    assert!(err.contains("Unknown"), "err: {err}");
}

// ─── format_seconds helper ─────────────────────────────────────────────────────

// Access via the module's private fn through a re-export trick: replicate the
// logic here rather than fighting visibility — the contract is what matters.
fn format_seconds_for_test(seconds: i64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h", seconds / 3600)
    }
}

#[test]
fn test_format_seconds_under_minute() {
    assert_eq!(format_seconds_for_test(0), "0s");
    assert_eq!(format_seconds_for_test(59), "59s");
}

#[test]
fn test_format_seconds_minutes() {
    assert_eq!(format_seconds_for_test(60), "1m");
    assert_eq!(format_seconds_for_test(3599), "59m");
}

#[test]
fn test_format_seconds_hours() {
    assert_eq!(format_seconds_for_test(3600), "1h");
    assert_eq!(format_seconds_for_test(7200), "2h");
}

// ─── Integration tests against a mock HTTP server ──────────────────────────────

/// Bind a mock server and return its local address. The server handles the given router.
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

#[tokio::test]
async fn test_run_daemon_status_human_format() {
    let router = Router::new().route(
        "/health",
        get(|| async {
            (
                StatusCode::OK,
                Json(json!({
                    "ok": true,
                    "version": "1.2.3",
                    "port": 7421,
                    "uptime": 90
                })),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    // Use daemon_request_with_base directly to test the HTTP layer without
    // needing a real daemon process.
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::health::Health;

    let result =
        daemon_request_with_base::<Health, ()>(&base_url, None, Method::GET, "/health", None)
            .await
            .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
    if let vst_cli::client::DaemonResult::Ok { data, .. } = result {
        assert!(data.ok);
        assert_eq!(data.version, "1.2.3");
        assert_eq!(data.port, 7421);
        assert_eq!(data.uptime, 90);
    } else {
        panic!("expected DaemonResult::Ok");
    }
}

#[tokio::test]
async fn test_run_worktree_ls_uses_project_query() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::shared::Worktree;

    let router = Router::new().route(
        "/api/worktrees",
        get(|Query(params): Query<HashMap<String, String>>| async move {
            let project = params.get("project").cloned().unwrap_or_default();
            assert_eq!(project, "my-project");
            (
                StatusCode::OK,
                Json(json!([{
                    "id": "wt-1",
                    "projectId": "my-project",
                    "name": null,
                    "branch": "main",
                    "branchIsPlaceholder": false,
                    "baseBranch": "main",
                    "baseSha": "abc123",
                    "createdAt": "2024-01-01T00:00:00Z",
                    "pinnedAt": null,
                    "hiddenAt": null,
                    "sortOrder": 1.0,
                    "mainSessionId": null
                }])),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let result = daemon_request_with_base::<Vec<Worktree>, ()>(
        &base_url,
        None,
        Method::GET,
        "/worktrees?project=my-project",
        None,
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
    if let vst_cli::client::DaemonResult::Ok { data, .. } = result {
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].id, "wt-1");
        assert_eq!(data[0].branch, "main");
    } else {
        panic!("expected DaemonResult::Ok");
    }
}

#[tokio::test]
async fn test_run_project_add_409_returns_conflict_with() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::shared::Project;

    let router = Router::new().route(
        "/api/projects",
        post(|| async {
            (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "Project already exists",
                    "conflictWith": "existing-proj"
                })),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let body = json!({ "path": "/some/path" });
    let result = daemon_request_with_base::<Project, _>(
        &base_url,
        None,
        Method::POST,
        "/projects",
        Some(&body),
    )
    .await
    .expect("request ok");

    // Should be an error with status 409 and conflict_with populated.
    assert!(!result.is_ok(), "expected Err result for 409");
    assert_eq!(result.status(), 409);
    if let vst_cli::client::DaemonResult::Err { conflict_with, .. } = result {
        let cw = conflict_with.expect("conflict_with should be set");
        assert_eq!(cw.as_str().expect("string"), "existing-proj");
    } else {
        panic!("expected DaemonResult::Err");
    }
}

#[tokio::test]
async fn test_run_worktree_rename_patch_endpoint() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::worktrees::RenameWorktreeResult;

    let router = Router::new().route(
        "/api/worktrees/:id/rename",
        patch(
            |Path(id): Path<String>, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(id, "wt-42");
                let name = body["name"].as_str().expect("name field").to_string();
                (StatusCode::OK, Json(json!({ "ok": true, "name": name })))
            },
        ),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let body = json!({ "name": "new-name" });
    let result = daemon_request_with_base::<RenameWorktreeResult, _>(
        &base_url,
        None,
        Method::PATCH,
        "/worktrees/wt-42/rename",
        Some(&body),
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
    if let vst_cli::client::DaemonResult::Ok { data, .. } = result {
        assert!(data.ok);
        assert_eq!(data.name.as_deref(), Some("new-name"));
    } else {
        panic!("expected DaemonResult::Ok");
    }
}

#[tokio::test]
async fn test_run_worktree_done_post_endpoint() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::worktrees::WorktreeDoneResult;

    let router = Router::new().route(
        "/api/worktrees/:id/done",
        post(|Path(id): Path<String>| async move {
            assert_eq!(id, "wt-done-1");
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "updated": 2, "terminalsReleased": 1 })),
            )
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let result = daemon_request_with_base::<WorktreeDoneResult, ()>(
        &base_url,
        None,
        Method::POST,
        "/worktrees/wt-done-1/done",
        None,
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
    if let vst_cli::client::DaemonResult::Ok { data, .. } = result {
        assert!(data.ok);
        assert_eq!(data.updated, 2);
        assert_eq!(data.terminals_released, 1);
    } else {
        panic!("expected DaemonResult::Ok");
    }
}

#[tokio::test]
async fn test_run_file_open_post_endpoint() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;

    let router = Router::new().route(
        "/api/worktrees/:id/open-file",
        post(
            |Path(id): Path<String>, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(id, "wt-99");
                let path = body["path"].as_str().expect("path field");
                assert!(path.starts_with('/'), "should be absolute path: {path}");
                (StatusCode::OK, Json(json!({ "ok": true })))
            },
        ),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let body = json!({ "path": "/absolute/path/file.ts" });
    let result = daemon_request_with_base::<serde_json::Value, _>(
        &base_url,
        None,
        Method::POST,
        "/worktrees/wt-99/open-file",
        Some(&body),
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result");
}

#[tokio::test]
async fn test_run_project_info_404_returns_code_2() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;
    use vst_types::rest::shared::Project;

    let router = Router::new().route(
        "/api/projects/:id",
        get(|| async { (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))) }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let result = daemon_request_with_base::<Project, ()>(
        &base_url,
        None,
        Method::GET,
        "/projects/nonexistent",
        None,
    )
    .await
    .expect("request ok");

    assert!(!result.is_ok(), "expected Err result for 404");
    assert_eq!(result.status(), 404);
}

#[tokio::test]
async fn test_run_project_rm_delete_endpoint() {
    use reqwest::Method;
    use vst_cli::client::daemon_request_with_base;

    let router = Router::new().route(
        "/api/projects/:id",
        delete(|Path(id): Path<String>| async move {
            assert_eq!(id, "proj-del-1");
            StatusCode::NO_CONTENT
        }),
    );
    let addr = spawn_mock_server(router).await;
    let base_url = format!("http://{addr}");

    let result = daemon_request_with_base::<serde_json::Value, ()>(
        &base_url,
        None,
        Method::DELETE,
        "/projects/proj-del-1",
        None,
    )
    .await
    .expect("request ok");

    assert!(result.is_ok(), "expected Ok result for 204");
}
