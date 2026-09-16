//! Behavior-contract tests for vst-cli session and mode commands (dispatch #2).
//!
//! ## Behavior contract
//!
//! ### Mode commands
//! - `parse_mode_ls_options` parses `--json`.
//! - `run_mode_ls` sends GET `/modes`, formats table or JSON.
//! - `parse_mode_add_options` validates `--name` and `--cli`, parses `--context`, `--preset`.
//! - `run_mode_add` posts CreateModeBody to `/modes`.
//! - `run_mode_rm` confirms and sends DELETE `/modes/{id}`.
//!
//! ### Session commands
//! - `parse_session_create_options` parses worktreeId, `--type`, `--mode`, `--prompt`, `--json`, `--parent`, `--no-parent`.
//! - `run_session_create` rejects `--prompt` when type != "agent", defaults parent to $VST_SESSION.
//! - `parse_session_ls_options` parses `--worktree`, `--name`, `--json`.
//! - `run_session_ls` filters by name client-side if provided.
//! - `parse_session_info_options` parses session id and `--json`.
//! - `run_session_info` displays fields or exits with JSON.
//! - `run_session_terminate` defaults to $VST_SESSION, sends DELETE `/sessions/{id}`.
//! - `run_session_restore` sends POST `/sessions/{id}/resume`.
//! - `parse_session_output_options` parses `--lines` (defaults to 100).
//! - `run_session_output` sends GET `/sessions/{id}/output?lines=N`.
//! - `parse_session_transcript_options` parses `--json`.
//! - `run_session_transcript` formats event stream or NDJSON.
//! - `parse_session_reset_options` parses `--handoff`, `--prompt`, `--mode`, `--handoff-file`.
//! - `run_session_reset` blocks `--handoff` on self session ($VST_SESSION).
//! - `run_session_handoff` sends POST `/sessions/{id}/handoff`.
//! - `parse_session_rename_options` parses `<id>` and `<name>`.
//! - `run_session_rename` sends PATCH `/sessions/{id}/rename`.
//! - `run_session_stop` sends POST `/sessions/{id}/chat/stop`.
//! - `parse_session_send_options` parses message, `--file`, `--attach`, `--queue`, `--wait`, `--no-wait`, `--timeout`.

use axum::extract::{Json, Path, Query};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::Router;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use tempfile::tempdir;

use vst_cli::commands::mode::add::{parse_mode_add_options, run_mode_add, ModeAddOptions};
use vst_cli::commands::mode::ls::{parse_mode_ls_options, run_mode_ls, ModeLsOptions};
use vst_cli::commands::session::create::{
    parse_session_create_options, run_session_create, SessionCreateOptions,
};
use vst_cli::commands::session::handoff::run_session_handoff;
use vst_cli::commands::session::info::{
    parse_session_info_options, run_session_info, SessionInfoOptions,
};
use vst_cli::commands::session::ls::{parse_session_ls_options, run_session_ls, SessionLsOptions};
use vst_cli::commands::session::output::{
    parse_session_output_options, run_session_output, SessionOutputOptions,
};
use vst_cli::commands::session::rename::{
    parse_session_rename_options, run_session_rename, SessionRenameOptions,
};
use vst_cli::commands::session::reset::{
    parse_session_reset_options, run_session_reset, SessionResetOptions,
};
use vst_cli::commands::session::restore::run_session_restore;
use vst_cli::commands::session::send::parse_session_send_options;
use vst_cli::commands::session::stop::run_session_stop;
use vst_cli::commands::session::terminate::run_session_terminate;
use vst_cli::commands::session::transcript::{
    parse_session_transcript_options, run_session_transcript, SessionTranscriptOptions,
};

#[test]
fn test_mode_ls_options_parsing() {
    let opts = parse_mode_ls_options(&["--json".to_string()]).expect("parse ok");
    assert!(opts.json);

    let opts_empty = parse_mode_ls_options(&[]).expect("parse empty ok");
    assert!(!opts_empty.json);

    let err = parse_mode_ls_options(&["--invalid".to_string()]);
    assert!(err.is_err());
}

#[test]
fn test_mode_add_options_parsing() {
    let args = vec![
        "--name".to_string(),
        "my-mode".to_string(),
        "--cli".to_string(),
        "claude".to_string(),
        "--context".to_string(),
        "be helpful".to_string(),
        "--preset".to_string(),
        "p1".to_string(),
    ];
    let opts = parse_mode_add_options(&args).expect("parse ok");
    assert_eq!(opts.name.as_deref(), Some("my-mode"));
    assert_eq!(opts.cli.as_deref(), Some("claude"));
    assert_eq!(opts.context.as_deref(), Some("be helpful"));
    assert_eq!(opts.preset.as_deref(), Some("p1"));
}

#[test]
fn test_session_create_options_parsing() {
    let args = vec![
        "wt-100".to_string(),
        "--type".to_string(),
        "agent".to_string(),
        "--mode".to_string(),
        "code".to_string(),
        "--prompt".to_string(),
        "do work".to_string(),
        "--json".to_string(),
        "--no-parent".to_string(),
    ];
    let opts = parse_session_create_options(&args).expect("parse ok");
    assert_eq!(opts.worktree_id, "wt-100");
    assert_eq!(opts.session_type, "agent");
    assert_eq!(opts.mode.as_deref(), Some("code"));
    assert_eq!(opts.prompt.as_deref(), Some("do work"));
    assert!(opts.json);
    assert!(opts.no_parent);
}

#[test]
fn test_session_create_prompt_terminal_rejected() {
    let opts = SessionCreateOptions {
        worktree_id: "wt-1".to_string(),
        session_type: "terminal".to_string(),
        prompt: Some("not allowed".to_string()),
        ..Default::default()
    };
    let res = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_session_create(opts));
    assert!(res.is_err());
    let (msg, code) = res.unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("only apply to --type=agent"));
}

#[test]
fn test_session_ls_options_parsing() {
    let args = vec![
        "--worktree".to_string(),
        "wt-2".to_string(),
        "--name".to_string(),
        "agent-1".to_string(),
        "--json".to_string(),
    ];
    let opts = parse_session_ls_options(&args).expect("parse ok");
    assert_eq!(opts.worktree.as_deref(), Some("wt-2"));
    assert_eq!(opts.name.as_deref(), Some("agent-1"));
    assert!(opts.json);
}

#[test]
fn test_session_info_options_parsing() {
    let args = vec!["sess-123".to_string(), "--json".to_string()];
    let opts = parse_session_info_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-123");
    assert!(opts.json);

    let err = parse_session_info_options(&[]);
    assert!(err.is_err());
}

#[test]
fn test_session_output_options_parsing() {
    let args = vec![
        "sess-456".to_string(),
        "--lines".to_string(),
        "50".to_string(),
    ];
    let opts = parse_session_output_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-456");
    assert_eq!(opts.lines, "50");
}

#[test]
fn test_session_transcript_options_parsing() {
    let args = vec!["sess-789".to_string(), "--json".to_string()];
    let opts = parse_session_transcript_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-789");
    assert!(opts.json);
}

#[test]
fn test_session_reset_options_parsing() {
    let args = vec![
        "sess-1".to_string(),
        "--handoff".to_string(),
        "--prompt".to_string(),
        "restarted".to_string(),
        "--mode".to_string(),
        "rust".to_string(),
    ];
    let opts = parse_session_reset_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-1");
    assert!(opts.handoff);
    assert_eq!(opts.prompt.as_deref(), Some("restarted"));
    assert_eq!(opts.mode.as_deref(), Some("rust"));
}

#[test]
fn test_session_reset_handoff_inside_self_session_rejected() {
    env::set_var("VST_SESSION", "s-self-123");
    let opts = SessionResetOptions {
        id: "s-self-123".to_string(),
        handoff: true,
        ..Default::default()
    };
    let res = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_session_reset(opts));
    assert!(res.is_err());
    let (msg, code) = res.unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("Cannot use --handoff on the session you are running inside"));
    env::remove_var("VST_SESSION");
}

#[test]
fn test_session_rename_options_parsing() {
    let args = vec!["sess-1".to_string(), "new-name".to_string()];
    let opts = parse_session_rename_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-1");
    assert_eq!(opts.name, "new-name");

    let err = parse_session_rename_options(&["sess-1".to_string()]);
    assert!(err.is_err());
}

#[test]
fn test_session_send_options_parsing() {
    let args = vec![
        "sess-1".to_string(),
        "hello".to_string(),
        "agent".to_string(),
        "--queue".to_string(),
        "--no-wait".to_string(),
        "--timeout".to_string(),
        "5000".to_string(),
    ];
    let opts = parse_session_send_options(&args).expect("parse ok");
    assert_eq!(opts.id, "sess-1");
    assert_eq!(opts.message, vec!["hello".to_string(), "agent".to_string()]);
    assert!(opts.send_options.queue);
    assert!(!opts.send_options.wait);
    assert_eq!(opts.send_options.timeout.as_deref(), Some("5000"));
}

#[tokio::test]
async fn test_mock_daemon_session_and_mode_endpoints() {
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "ok": true,
                    "version": "0.1.0",
                    "port": 8888,
                    "uptime": 1
                }))
            }),
        )
        .route(
            "/modes",
            get(|| async {
                Json(json!([
                    {
                        "id": "mode-1",
                        "name": "General Agent",
                        "cli": "claude",
                        "context": "help user",
                        "createdAt": "2026-09-15T00:00:00Z"
                    }
                ]))
            })
            .post(|Json(body): Json<serde_json::Value>| async move {
                let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name == "conflict" {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({ "error": "Mode name already exists", "conflictWith": "mode-exist" })),
                    );
                }
                (
                    StatusCode::OK,
                    Json(json!({
                        "id": "mode-new",
                        "name": name,
                        "cli": "claude",
                        "context": "",
                        "createdAt": "2026-09-15T00:00:00Z"
                    })),
                )
            }),
        )
        .route(
            "/modes/:id",
            delete(|Path(id): Path<String>| async move {
                if id == "not-found" {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Mode not found" })),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({ "ok": true, "affectedSessions": 0 })),
                    )
                }
            }),
        )
        .route(
            "/sessions",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                let wt = params.get("worktree").map(String::as_str);
                let all = vec![
                    json!({
                        "id": "sess-wt-1",
                        "worktreeId": "wt-1",
                        "projectId": "proj-1",
                        "isMain": true,
                        "type": "agent",
                        "tmuxName": "vst_wt1",
                        "useTmux": true,
                        "channel": "tmux",
                        "state": "idle",
                        "lifecycleState": "idle",
                        "createdAt": "2026-09-15T00:00:00Z",
                        "sortOrder": 1.0,
                        "name": "primary"
                    }),
                    json!({
                        "id": "sess-wt-2",
                        "worktreeId": "wt-2",
                        "projectId": "proj-1",
                        "isMain": false,
                        "type": "terminal",
                        "tmuxName": "vst_wt2",
                        "useTmux": true,
                        "channel": "tmux",
                        "state": "working",
                        "lifecycleState": "working",
                        "createdAt": "2026-09-15T00:00:00Z",
                        "sortOrder": 2.0,
                        "name": "term"
                    }),
                ];

                let filtered: Vec<serde_json::Value> = if let Some(target_wt) = wt {
                    all.into_iter()
                        .filter(|s| s.get("worktreeId").and_then(|v| v.as_str()) == Some(target_wt))
                        .collect()
                } else {
                    all
                };

                Json(filtered)
            })
            .post(|Json(body): Json<serde_json::Value>| async move {
                let wt = body.get("worktreeId").and_then(|v| v.as_str()).unwrap_or("");
                if wt == "wt-missing" {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Worktree not found" })),
                    );
                }
                (
                    StatusCode::OK,
                    Json(json!({
                        "id": "sess-created-1",
                        "worktreeId": wt,
                        "projectId": "p1",
                        "isMain": false,
                        "type": "agent",
                        "tmuxName": "vst_sess1",
                        "useTmux": true,
                        "channel": "json",
                        "state": "idle",
                        "lifecycleState": "idle",
                        "createdAt": "2026-09-15T00:00:00Z",
                        "sortOrder": 1.0
                    })),
                )
            }),
        )
        .route(
            "/sessions/:id",
            get(|Path(id): Path<String>| async move {
                if id == "not-found" {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Session not found" })),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "id": id,
                            "worktreeId": "wt-1",
                            "projectId": "p1",
                            "isMain": true,
                            "type": "agent",
                            "tmuxName": format!("vst_{id}"),
                            "useTmux": true,
                            "channel": "json",
                            "state": "idle",
                            "lifecycleState": "idle",
                            "createdAt": "2026-09-15T00:00:00Z",
                            "sortOrder": 1.0,
                            "name": "main-agent"
                        })),
                    )
                }
            })
            .delete(|Path(id): Path<String>| async move {
                if id == "not-found" {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "error": "Session not found" })),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({ "ok": true })),
                    )
                }
            }),
        )
        .route(
            "/sessions/:id/output",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "id": id,
                    "output": "line 1\nline 2\n"
                }))
            }),
        )
        .route(
            "/sessions/:id/transcript",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "events": [
                        {
                            "id": "ev-1",
                            "sessionId": id,
                            "ts": "2026-09-15T00:00:00Z",
                            "provider": "claude",
                            "kind": "user",
                            "role": "user",
                            "text": "do something"
                        }
                    ]
                }))
            }),
        )
        .route(
            "/sessions/:id/reset",
            post(|Path(id): Path<String>| async move {
                Json(json!({
                    "ok": true,
                    "archivedSessionId": id,
                    "newSessionId": "sess-new-2"
                }))
            }),
        )
        .route(
            "/sessions/:id/handoff",
            post(|Path(_id): Path<String>| async move {
                Json(json!({
                    "ok": true,
                    "handoffSummary": "summary of work done"
                }))
            }),
        )
        .route(
            "/sessions/:id/rename",
            patch(|Path(_id): Path<String>, Json(body): Json<serde_json::Value>| async move {
                let name = body.get("name").and_then(|v| v.as_str()).map(ToString::to_string);
                Json(json!({
                    "ok": true,
                    "name": name
                }))
            }),
        )
        .route(
            "/sessions/:id/chat/stop",
            post(|Path(_id): Path<String>| async move {
                Json(json!({ "ok": true }))
            }),
        )
        .route(
            "/sessions/:id/resume",
            post(|Path(_id): Path<String>| async move {
                Json(json!({ "ok": true }))
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    let base_url = format!("http://{addr}");

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // Set up mock config for vst-cli to point to this mock server
    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(
        vst_dir.join("config.json"),
        format!(r#"{{"port": {}}}"#, addr.port()),
    )
    .expect("write config");

    env::set_var("VST_DAEMON_URL", &base_url);

    // Verify GET /modes
    let mode_ls_res = run_mode_ls(ModeLsOptions { json: false }).await;
    assert!(mode_ls_res.is_ok());

    // Verify POST /modes success
    let mode_add_res = run_mode_add(ModeAddOptions {
        name: Some("test-mode".to_string()),
        cli: Some("claude".to_string()),
        context: Some("test context".to_string()),
        context_file: None,
        preset: None,
    })
    .await;
    assert!(mode_add_res.is_ok());

    // Verify POST /modes 409 conflict
    let mode_conflict_res = run_mode_add(ModeAddOptions {
        name: Some("conflict".to_string()),
        cli: Some("claude".to_string()),
        context: None,
        context_file: None,
        preset: None,
    })
    .await;
    assert!(mode_conflict_res.is_err());
    let (err_msg, code) = mode_conflict_res.unwrap_err();
    assert_eq!(code, 3);
    assert!(err_msg.contains("already exists"));

    // Verify POST /sessions success
    let sess_create_res = run_session_create(SessionCreateOptions {
        worktree_id: "wt-1".to_string(),
        session_type: "agent".to_string(),
        mode: None,
        prompt: None,
        prompt_file: None,
        json: true,
        parent: None,
        no_parent: true,
    })
    .await;
    assert!(sess_create_res.is_ok());

    // Verify POST /sessions 404
    let sess_create_404 = run_session_create(SessionCreateOptions {
        worktree_id: "wt-missing".to_string(),
        session_type: "agent".to_string(),
        mode: None,
        prompt: None,
        prompt_file: None,
        json: false,
        parent: None,
        no_parent: true,
    })
    .await;
    assert!(sess_create_404.is_err());
    let (err_msg, code) = sess_create_404.unwrap_err();
    assert_eq!(code, 2);
    assert!(err_msg.contains("not found"));

    // Verify GET /sessions with worktree filter
    let sess_ls_res = run_session_ls(SessionLsOptions {
        worktree: Some("wt-1".to_string()),
        name: None,
        json: false,
    })
    .await;
    assert!(sess_ls_res.is_ok());

    // Verify GET /sessions/:id
    let sess_info_res = run_session_info(SessionInfoOptions {
        id: "sess-wt-1".to_string(),
        json: false,
    })
    .await;
    assert!(sess_info_res.is_ok());

    // Verify GET /sessions/:id 404
    let sess_info_404 = run_session_info(SessionInfoOptions {
        id: "not-found".to_string(),
        json: false,
    })
    .await;
    assert!(sess_info_404.is_err());
    let (_, code) = sess_info_404.unwrap_err();
    assert_eq!(code, 2);

    // Verify DELETE /sessions/:id
    let sess_term_res = run_session_terminate(Some("sess-wt-1".to_string())).await;
    assert!(sess_term_res.is_ok());

    // Verify GET /sessions/:id/output
    let sess_output_res = run_session_output(SessionOutputOptions {
        id: "sess-wt-1".to_string(),
        lines: "100".to_string(),
    })
    .await;
    assert!(sess_output_res.is_ok());

    // Verify GET /sessions/:id/transcript
    let sess_trans_res = run_session_transcript(SessionTranscriptOptions {
        id: "sess-wt-1".to_string(),
        json: false,
    })
    .await;
    assert!(sess_trans_res.is_ok());

    // Verify POST /sessions/:id/reset
    let sess_reset_res = run_session_reset(SessionResetOptions {
        id: "sess-wt-1".to_string(),
        handoff: false,
        prompt: Some("reprompt".to_string()),
        mode: None,
        handoff_file: None,
    })
    .await;
    assert!(sess_reset_res.is_ok());

    // Verify POST /sessions/:id/handoff
    let sess_handoff_res = run_session_handoff("sess-wt-1").await;
    assert!(sess_handoff_res.is_ok());

    // Verify PATCH /sessions/:id/rename
    let sess_rename_res = run_session_rename(SessionRenameOptions {
        id: "sess-wt-1".to_string(),
        name: "renamed-agent".to_string(),
    })
    .await;
    assert!(sess_rename_res.is_ok());

    // Verify POST /sessions/:id/chat/stop
    let sess_stop_res = run_session_stop("sess-wt-1").await;
    assert!(sess_stop_res.is_ok());

    // Verify POST /sessions/:id/resume
    let sess_resume_res = run_session_restore("sess-wt-1").await;
    assert!(sess_resume_res.is_ok());

    env::remove_var("VST_DAEMON_URL");
}
