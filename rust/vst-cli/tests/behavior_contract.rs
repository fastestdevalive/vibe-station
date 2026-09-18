//! Behavior-contract tests for vst-cli core plumbing (dispatch #1).
//!
//! ## Behavior contract
//!
//! ### daemon_url.rs
//! - `get_daemon_url_from_home_and_env` reads `~/.vibe-station/config.json` port.
//! - `VST_DAEMON_URL` env var overrides config file.
//! - `port == 0` or missing port returns `None`.
//! - `get_daemon_token_from_home` reads `cliToken` field or `None`.
//!
//! ### paths.rs
//! - `daemon_log_path_from_home` resolves to `<home>/.vibe-station/logs/daemon.log`.
//!
//! ### env.rs
//! - Reads `VST_PROJECT`, `VST_WORKTREE`, `VST_SESSION`, `VST_DAEMON_URL`.
//!
//! ### output.rs
//! - `format_table` computes correct column widths, headers, and `─` separator joined by `──`.
//!
//! ### text_source.rs
//! - `try_resolve_file_or_inline(Some(inline), None, _)` returns inline.
//! - Reads valid file and returns its content.
//! - Non-existent file returns `Err` with "Cannot read <flag> <path>".
//! - Whitespace-only or empty file returns `Ok(None)` with warning.
//!
//! ### confirm.rs
//! - `confirm_by_typing_name_with_reader` succeeds when typed input matches name.
//! - Mismatched input or EOF returns `Err("Cancelled.")`.
//!
//! ### client.rs
//! - `DaemonResult` encapsulates `status`, `data` or `error` and `conflict_with`.
//! - `daemon_request_with_base` parses 2xx JSON into `DaemonResult::Ok`.
//! - `daemon_request_with_base` parses non-2xx into `DaemonResult::Err` with error field.
//!
//! ### preflight.rs
//! - `preflight_with_url` succeeds on HTTP 200 `/health`.
//! - Returns `Err` on HTTP error status or connection failure.
//!
//! ### program.rs
//! - Parses top-level subcommands: `daemon`, `project`, `worktree`, `session`, `mode`, `file`, `open`, `status`, `summary`, `doctor`.
//! - Parses version and help flags.

use std::fs;
use std::io::Cursor;
use tempfile::tempdir;
use vst_cli::client::{daemon_request_with_base, DaemonResult};
use vst_cli::confirm::confirm_by_typing_name_with_reader;
use vst_cli::daemon_url::{get_daemon_token_from_home, get_daemon_url_from_home_and_env};
use vst_cli::output::format_table;
use vst_cli::paths::daemon_log_path_from_home;
use vst_cli::preflight::preflight_with_url;
use vst_cli::program::{parse_args, Command, DaemonCommand, SessionCommand, WorktreeCommand};
use vst_cli::text_source::try_resolve_file_or_inline;

#[test]
fn test_daemon_url_reads_config_file() {
    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(
        vst_dir.join("config.json"),
        r#"{"port": 7422, "cliToken": "tok_123"}"#,
    )
    .expect("write");

    let url = get_daemon_url_from_home_and_env(Some(tmp.path()), None);
    assert_eq!(url, Some("http://127.0.0.1:7422".to_string()));

    let token = get_daemon_token_from_home(Some(tmp.path()));
    assert_eq!(token, Some("tok_123".to_string()));
}

#[test]
fn test_daemon_url_env_override() {
    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(vst_dir.join("config.json"), r#"{"port": 7422}"#).expect("write");

    let url =
        get_daemon_url_from_home_and_env(Some(tmp.path()), Some("http://custom:1234".to_string()));
    assert_eq!(url, Some("http://custom:1234".to_string()));
}

#[test]
fn test_daemon_url_missing_or_zero_port() {
    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(vst_dir.join("config.json"), r#"{"port": 0}"#).expect("write");

    let url = get_daemon_url_from_home_and_env(Some(tmp.path()), None);
    assert_eq!(url, None);
}

#[test]
fn test_paths_daemon_log_path() {
    let tmp = tempdir().expect("tempdir");
    let p = daemon_log_path_from_home(Some(tmp.path()));
    assert_eq!(
        p,
        tmp.path()
            .join(".vibe-station")
            .join("logs")
            .join("daemon.log")
    );
}

#[test]
fn test_output_format_table() {
    let headers = ["ID", "NAME", "STATUS"];
    let rows = vec![
        vec![
            "vs-1".to_string(),
            "first".to_string(),
            "running".to_string(),
        ],
        vec![
            "vs-12345".to_string(),
            "second-longer".to_string(),
            "idle".to_string(),
        ],
    ];

    let lines = format_table(&headers, &rows);
    assert_eq!(lines.len(), 4);
    assert!(lines[0].starts_with("ID"));
    assert!(lines[1].contains("─"));
    assert!(lines[2].contains("vs-1"));
    assert!(lines[3].contains("vs-12345"));
}

#[test]
fn test_text_source_inline_when_no_file() {
    let res = try_resolve_file_or_inline(Some("hello inline".to_string()), None, "--prompt-file");
    assert_eq!(res.expect("ok"), Some("hello inline".to_string()));
}

#[test]
fn test_text_source_reads_file() {
    let tmp = tempdir().expect("tempdir");
    let file = tmp.path().join("prompt.txt");
    fs::write(&file, "task prompt contents").expect("write");

    let res = try_resolve_file_or_inline(
        None,
        Some(file.to_str().unwrap().to_string()),
        "--prompt-file",
    );
    assert_eq!(res.expect("ok"), Some("task prompt contents".to_string()));
}

#[test]
fn test_text_source_empty_file_returns_none() {
    let tmp = tempdir().expect("tempdir");
    let file = tmp.path().join("empty.txt");
    fs::write(&file, "  \n  \t  ").expect("write");

    let res = try_resolve_file_or_inline(
        Some("default".to_string()),
        Some(file.to_str().unwrap().to_string()),
        "--prompt-file",
    );
    assert_eq!(res.expect("ok"), None);
}

#[test]
fn test_text_source_nonexistent_file_errors() {
    let res = try_resolve_file_or_inline(
        None,
        Some("/tmp/nonexistent_file_abc123.txt".to_string()),
        "--prompt-file",
    );
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("Cannot read --prompt-file"));
}

#[test]
fn test_confirm_by_typing_name_success() {
    let mut reader = Cursor::new("delete-me\n");
    let res = confirm_by_typing_name_with_reader(&mut reader, "delete-me", "Careful!");
    assert!(res.is_ok());
}

#[test]
fn test_confirm_by_typing_name_cancelled() {
    let mut reader = Cursor::new("wrong\n");
    let res = confirm_by_typing_name_with_reader(&mut reader, "delete-me", "Careful!");
    assert_eq!(res.unwrap_err(), "Cancelled.");
}

#[test]
fn test_program_parse_args() {
    let v = parse_args(vec!["vst", "--version"]);
    assert_eq!(v, Command::Version);

    let h = parse_args(vec!["vst", "-h"]);
    assert_eq!(h, Command::Help);

    let d = parse_args(vec!["vst", "daemon", "status", "--json"]);
    assert_eq!(d, Command::Daemon(DaemonCommand::Status { json: true }));

    let s = parse_args(vec![
        "vst", "session", "send", "s-123", "hello", "world", "--wait",
    ]);
    assert_eq!(
        s,
        Command::Session(SessionCommand::Send {
            args: vec![
                "s-123".to_string(),
                "hello".to_string(),
                "world".to_string(),
                "--wait".to_string(),
            ]
        })
    );

    let w = parse_args(vec!["vst", "worktree", "ls", "--json"]);
    assert_eq!(
        w,
        Command::Worktree(WorktreeCommand::Ls {
            args: vec!["--json".to_string()]
        })
    );
}

#[tokio::test]
async fn test_client_and_preflight_mock_server() {
    use axum::extract::Json;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;
    use serde_json::json;

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "ok": true,
                    "version": "0.1.0",
                    "port": 9999,
                    "uptime": 10
                }))
            }),
        )
        .route(
            "/api/test-ok",
            get(|| async {
                Json(json!({
                    "message": "success"
                }))
            }),
        )
        .route(
            "/api/test-err",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({
                        "error": "Item not found",
                        "conflictWith": "item_123"
                    })),
                )
                    .into_response()
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    let base_url = format!("http://{}", addr);

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // Test preflight against mock server
    let preflight_res = preflight_with_url(&base_url, None).await;
    assert!(preflight_res.is_ok());

    // Test daemon_request_with_base 2xx
    let ok_res = daemon_request_with_base::<serde_json::Value, ()>(
        &base_url,
        None,
        reqwest::Method::GET,
        "/test-ok",
        None,
    )
    .await
    .expect("request ok");

    assert!(ok_res.is_ok());
    assert_eq!(ok_res.status(), 200);
    if let DaemonResult::Ok { data, .. } = ok_res {
        assert_eq!(
            data.get("message").and_then(|m| m.as_str()),
            Some("success")
        );
    } else {
        panic!("expected DaemonResult::Ok");
    }

    // Test daemon_request_with_base 4xx
    let err_res = daemon_request_with_base::<serde_json::Value, ()>(
        &base_url,
        None,
        reqwest::Method::GET,
        "/test-err",
        None,
    )
    .await
    .expect("request err");

    assert!(!err_res.is_ok());
    assert_eq!(err_res.status(), 404);
    if let DaemonResult::Err {
        error,
        conflict_with,
        ..
    } = err_res
    {
        assert_eq!(error, "Item not found");
        assert_eq!(
            conflict_with.and_then(|c| c.as_str().map(|s| s.to_string())),
            Some("item_123".to_string())
        );
    } else {
        panic!("expected DaemonResult::Err");
    }
}
