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
//! ### Agent commands
//! - `parse_agent_create_options` parses worktreeId, `--channel`, `--mode`, `--prompt`, `--parent`, `--no-parent`.
//! - `run_agent_create` validates channel is 'tmux' or 'json', defaults parent to $VST_SESSION.
//! ### Terminal commands
//! - `parse_terminal_create_options` parses worktreeId, `--parent`, `--no-parent`.
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
//! - `parse_session_start_fresh_options` parses `--carry`, `--summary-file`, `--when-busy`, `--queued`, `--channel`, `--prompt`, `--json` (carry defaults to `none`).
//! - `parse_session_switch_options` requires `--mode` and rejects `--carry=none`.
//! - `check_self_target` refuses `--carry=summary` without `--summary-file` and `--when-busy=wait` on `$VST_SESSION`.
//! - `run_session_start_fresh` / `run_session_switch` POST `/sessions/{id}/reset` and print the result.
//! - `run_session_previous` walks the `supersededBy` chain.
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
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

/// Serializes the mock-daemon tests that mutate the process-global
/// `VST_DAEMON_URL` env var — they must not run concurrently, or a request
/// from one test can be routed to another's mock server (flaky `captured`
/// stays `None`).
static MOCK_DAEMON_URL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use vst_cli::commands::agent::carry::{
    check_self_target, parse_when_busy, result_json, success_line, CarryOptions, SUMMARY_FAILED,
};
use vst_cli::commands::agent::create::{
    parse_agent_create_options, run_agent_create, AgentCreateOptions,
};
use vst_cli::commands::agent::handoff::run_session_handoff;
use vst_cli::commands::agent::info::{
    parse_session_info_options, run_session_info, SessionInfoOptions,
};
use vst_cli::commands::agent::ls::{parse_session_ls_options, run_session_ls, SessionLsOptions};
use vst_cli::commands::agent::output::{
    parse_session_output_options, run_session_output, SessionOutputOptions,
};
use vst_cli::commands::agent::previous::{
    build_rows, parse_session_previous_options, run_session_previous,
};
use vst_cli::commands::agent::rename::{
    parse_session_rename_options, run_session_rename, SessionRenameOptions,
};
use vst_cli::commands::agent::restore::run_session_restore;
use vst_cli::commands::agent::send::parse_session_send_options;
use vst_cli::commands::agent::start_fresh::{
    parse_session_start_fresh_options, run_session_start_fresh,
};
use vst_cli::commands::agent::stop::run_session_stop;
use vst_cli::commands::agent::switch::{parse_session_switch_options, run_session_switch};
use vst_cli::commands::agent::terminate::run_session_terminate;
use vst_cli::commands::agent::transcript::{
    parse_session_transcript_options, run_session_transcript, SessionTranscriptOptions,
};
use vst_cli::commands::mode::add::{parse_mode_add_options, run_mode_add, ModeAddOptions};
use vst_cli::commands::mode::ls::{parse_mode_ls_options, run_mode_ls, ModeLsOptions};
use vst_cli::commands::terminal::create::parse_terminal_create_options;

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
fn test_agent_create_options_parsing() {
    let args = vec![
        "wt-100".to_string(),
        "--mode".to_string(),
        "code".to_string(),
        "--prompt".to_string(),
        "do work".to_string(),
        "--channel".to_string(),
        "json".to_string(),
        "--no-parent".to_string(),
    ];
    let opts = parse_agent_create_options(&args).expect("parse ok");
    assert_eq!(opts.worktree_id, "wt-100");
    assert_eq!(opts.mode.as_deref(), Some("code"));
    assert_eq!(opts.prompt.as_deref(), Some("do work"));
    assert_eq!(opts.channel, Some("json".to_string()));
    assert!(opts.no_parent);

    let opts_parent =
        parse_agent_create_options(&["wt-100".to_string(), "--parent=p-sess-1".to_string()])
            .expect("parse parent ok");
    assert_eq!(opts_parent.parent.as_deref(), Some("p-sess-1"));
    // No --channel passed -> default is None (daemon resolves the effective default).
    assert_eq!(opts_parent.channel, None);

    let opts_src_agent = parse_agent_create_options(&[
        "wt-100".to_string(),
        "--source-agent".to_string(),
        "src-sess-2".to_string(),
    ])
    .expect("parse source-agent ok");
    assert_eq!(opts_src_agent.parent.as_deref(), Some("src-sess-2"));

    let opts_project = parse_agent_create_options(&[
        "--project=proj-alpha".to_string(),
        "--parent=p-direct-1".to_string(),
        "--prompt=hello".to_string(),
    ])
    .expect("parse project ok");
    assert_eq!(opts_project.project_id.as_deref(), Some("proj-alpha"));
    assert_eq!(opts_project.parent.as_deref(), Some("p-direct-1"));
    assert_eq!(opts_project.prompt.as_deref(), Some("hello"));
}

#[test]
fn test_agent_create_invalid_channel_rejected() {
    let opts = AgentCreateOptions {
        worktree_id: "wt-1".to_string(),
        channel: Some("pty".to_string()),
        ..Default::default()
    };
    let res = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_agent_create(opts));
    assert!(res.is_err());
    let (msg, code) = res.unwrap_err();
    assert_eq!(code, 1);
    assert!(msg.contains("--channel must be 'tmux' or 'json'"));
}

#[test]
fn test_terminal_create_options_parsing() {
    let args = vec!["wt-100".to_string(), "--no-parent".to_string()];
    let opts = parse_terminal_create_options(&args).expect("parse ok");
    assert_eq!(opts.worktree_id, "wt-100");
    assert!(opts.no_parent);

    let opts_parent =
        parse_terminal_create_options(&["wt-200".to_string(), "--parent=p-sess-1".to_string()])
            .expect("parse parent ok");
    assert_eq!(opts_parent.parent.as_deref(), Some("p-sess-1"));

    let err = parse_terminal_create_options(&[]);
    assert!(err.is_err());
    assert!(err.unwrap_err().contains("worktreeId is required"));
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
fn test_session_start_fresh_options_default_to_none() {
    let args = vec!["sess-1".to_string()];
    let opts = parse_session_start_fresh_options(&args).expect("parse ok");
    assert_eq!(opts.carry.id, "sess-1");
    assert_eq!(
        opts.carry.carry,
        Some(vst_types::domain::CarryOver::Nothing)
    );
    assert_eq!(
        opts.carry.when_busy,
        vst_types::rest::sessions::WhenBusy::Stop
    );
    assert_eq!(
        opts.carry.queued,
        vst_types::rest::sessions::QueuedPolicy::Carry
    );
    assert!(!opts.carry.json);
}

#[test]
fn test_session_start_fresh_options_parse_all_flags() {
    let args = vec![
        "sess-1".to_string(),
        "--carry=transcript".to_string(),
        "--prompt".to_string(),
        "restarted".to_string(),
        "--when-busy=stop".to_string(),
        "--queued=drop".to_string(),
        "--channel=json".to_string(),
        "--json".to_string(),
    ];
    let opts = parse_session_start_fresh_options(&args).expect("parse ok");
    assert_eq!(
        opts.carry.carry,
        Some(vst_types::domain::CarryOver::Transcript)
    );
    assert_eq!(opts.carry.prompt.as_deref(), Some("restarted"));
    assert_eq!(
        opts.carry.queued,
        vst_types::rest::sessions::QueuedPolicy::Drop
    );
    assert_eq!(opts.carry.channel, Some(vst_types::domain::Channel::Json));
    assert!(opts.carry.json);
}

#[test]
fn test_session_switch_options_require_mode() {
    let err = parse_session_switch_options(&["sess-1".to_string()]).expect_err("mode required");
    assert!(err.contains("--mode is required"), "err was: {err}");
}

#[test]
fn test_session_switch_options_default_to_summary() {
    let args = vec![
        "sess-1".to_string(),
        "--mode".to_string(),
        "rust".to_string(),
    ];
    let opts = parse_session_switch_options(&args).expect("parse ok");
    assert_eq!(opts.mode, "rust");
    assert_eq!(
        opts.carry.carry,
        Some(vst_types::domain::CarryOver::Summary)
    );
}

#[test]
fn test_session_switch_rejects_carry_none() {
    let args = vec![
        "sess-1".to_string(),
        "--mode=rust".to_string(),
        "--carry=none".to_string(),
    ];
    let err = parse_session_switch_options(&args).expect_err("none rejected");
    assert!(
        err.contains("--carry=none is not available for switch"),
        "err was: {err}"
    );
}

#[test]
fn test_bad_when_busy_and_unknown_flag() {
    let err = parse_session_start_fresh_options(&[
        "sess-1".to_string(),
        "--when-busy=sometimes".to_string(),
    ])
    .expect_err("bad when-busy");
    assert!(err.contains("Invalid --when-busy value"), "err was: {err}");

    let err = parse_session_start_fresh_options(&["sess-1".to_string(), "--bogus".to_string()])
        .expect_err("unknown flag");
    assert!(err.contains("Unknown option"), "err was: {err}");

    assert!(parse_when_busy("wait").is_ok());
    assert!(parse_when_busy("nope").is_err());
}

#[test]
fn test_start_fresh_rejects_mode_flag() {
    let err = parse_session_start_fresh_options(&["sess-1".to_string(), "--mode=rust".to_string()])
        .expect_err("start-fresh has no mode");
    assert!(err.contains("Unknown option: --mode"), "err was: {err}");
}

#[test]
fn test_unreadable_summary_file_rejected() {
    let missing = "/definitely/not/a/real/summary-file-xyz.md";
    let opts = parse_session_start_fresh_options(&[
        "sess-1".to_string(),
        "--carry=summary".to_string(),
        format!("--summary-file={missing}"),
    ])
    .expect("parse stores the path");
    // Parsing itself only records the path; the read is fail-loud at run time.
    assert_eq!(opts.carry.summary_file.as_deref(), Some(missing));
    let read_err = vst_cli::commands::agent::carry::resolve_summary_text(&opts.carry)
        .expect_err("unreadable file must fail loudly");
    assert!(
        read_err.contains("Cannot read --summary-file"),
        "err was: {read_err}"
    );
}

#[test]
fn test_self_target_guard() {
    env::set_var("VST_SESSION", "s-self-123");
    let base = CarryOptions {
        id: "s-self-123".to_string(),
        ..Default::default()
    };

    // summary without a file is refused, with the file hint.
    let summary = CarryOptions {
        carry: Some(vst_types::domain::CarryOver::Summary),
        ..base.clone()
    };
    let (msg, code) = check_self_target(&summary, vst_types::domain::CarryOver::Summary)
        .expect_err("summary refused");
    assert_eq!(code, 1);
    assert!(msg.contains("--summary-file"), "msg was: {msg}");

    // ...allowed once the caller supplies the summary file.
    let with_file = CarryOptions {
        summary_file: Some("/tmp/s.md".to_string()),
        ..summary.clone()
    };
    assert!(check_self_target(&with_file, vst_types::domain::CarryOver::Summary).is_ok());

    // wait is refused outright (Decision 7).
    let wait = CarryOptions {
        when_busy: vst_types::rest::sessions::WhenBusy::Wait,
        ..base.clone()
    };
    let (msg, code) =
        check_self_target(&wait, vst_types::domain::CarryOver::Nothing).expect_err("wait refused");
    assert_eq!(code, 1);
    assert!(msg.contains("--when-busy=wait"), "msg was: {msg}");

    // none and transcript are allowed.
    assert!(check_self_target(&base, vst_types::domain::CarryOver::Nothing).is_ok());
    assert!(check_self_target(&base, vst_types::domain::CarryOver::Transcript).is_ok());

    // A DIFFERENT session is never guarded, even with summary-without-file or
    // wait (only $VST_SESSION itself is special).
    let other = CarryOptions {
        id: "s-other".to_string(),
        carry: Some(vst_types::domain::CarryOver::Summary),
        when_busy: vst_types::rest::sessions::WhenBusy::Wait,
        ..Default::default()
    };
    assert!(check_self_target(&other, vst_types::domain::CarryOver::Summary).is_ok());

    env::remove_var("VST_SESSION");
}

#[test]
fn test_reset_output_shapes() {
    use vst_types::domain::{CarryOver, SessionBreakKind};
    use vst_types::rest::sessions::ResetResult;

    let data = ResetResult {
        ok: true,
        archived_session_id: "old".to_string(),
        new_session_id: "new".to_string(),
        carry_over: CarryOver::Summary,
        break_kind: Some(SessionBreakKind::Reset),
    };
    assert_eq!(
        success_line("Started fresh", &data),
        "Started fresh. Archived: old, New: new (carried: summary)"
    );
    assert_eq!(
        result_json(&data),
        json!({
            "ok": true,
            "archivedSessionId": "old",
            "newSessionId": "new",
            "carryOver": "summary",
            "breakKind": "reset"
        })
    );

    let nothing = ResetResult {
        carry_over: CarryOver::Nothing,
        break_kind: None,
        ..data
    };
    let json_value = result_json(&nothing);
    assert_eq!(json_value["carryOver"], json!("none"));
    assert!(json_value.get("breakKind").is_none());
    assert_eq!(
        SUMMARY_FAILED,
        "Summary was not written; nothing changed. Retry with --carry=transcript."
    );
}

#[test]
fn test_previous_options_parsing() {
    let opts = parse_session_previous_options(&["sess-1".to_string(), "--json".to_string()])
        .expect("parse ok");
    assert_eq!(opts.id, "sess-1");
    assert!(opts.json);

    let err = parse_session_previous_options(&[]).expect_err("id required");
    assert!(err.contains("Session ID is required"), "err was: {err}");
}

#[test]
fn test_previous_walks_three_session_chain() {
    use vst_types::domain::{Channel, LifecycleState, SessionType};
    use vst_types::rest::shared::{Mode, Session};

    fn session(id: &str, mode: &str, superseded_by: Option<&str>) -> Session {
        Session {
            id: id.to_string(),
            worktree_id: Some("wt-1".to_string()),
            project_id: "p1".to_string(),
            is_main: true,
            r#type: SessionType::Agent,
            mode_id: Some(mode.to_string()),
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: format!("vst_{id}"),
            use_tmux: false,
            channel: Channel::Json,
            state: LifecycleState::Exited,
            lifecycle_state: LifecycleState::Exited,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            pinned_at: None,
            archived_at: Some("2026-01-02T00:00:00Z".to_string()),
            sort_order: 1.0,
            handoff_summary: Some(format!("summary {id}")),
            carry_over: None,
            parent_session_id: None,
            superseded_by: superseded_by.map(ToString::to_string),
            pr: None,
            draft_prompt: None,
            draft_config: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    fn mode(id: &str, name: &str) -> Mode {
        Mode {
            id: id.to_string(),
            name: name.to_string(),
            cli: vst_types::domain::CliId::Claude,
            context: String::new(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            model: None,
            icon: None,
        }
    }

    let mut sessions = vec![
        session("s-old", "m-1", Some("s-mid")),
        session("s-mid", "m-2", Some("s-new")),
        session("s-new", "m-2", None),
    ];
    sessions[1].carry_over = Some(vst_types::domain::CarryOver::Transcript);
    let modes = vec![
        mode("m-1", "opus-planner"),
        mode("m-2", "sonnet-implementer"),
    ];

    let rows = build_rows("s-new", &sessions, &modes);
    assert_eq!(rows.len(), 2, "two predecessors, newest first");
    assert_eq!(
        rows[0].carry_over,
        Some(vst_types::domain::CarryOver::Transcript)
    );
    assert_eq!(rows[1].carry_over, None, "older record: not recorded");
    let json = serde_json::to_value(&rows).unwrap();
    assert_eq!(json[0]["carryOver"], "transcript");
    assert!(json[1]["carryOver"].is_null());
    assert_eq!(rows[0].id, "s-mid");
    assert_eq!(rows[0].mode.as_deref(), Some("sonnet-implementer"));
    assert_eq!(rows[0].kind, "fresh", "same mode as successor");
    assert_eq!(rows[1].id, "s-old");
    assert_eq!(rows[1].mode.as_deref(), Some("opus-planner"));
    assert_eq!(rows[1].kind, "switch", "mode differs from successor");
    assert_eq!(rows[1].archived_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    assert_eq!(rows[1].summary.as_deref(), Some("summary s-old"));
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
#[allow(clippy::await_holding_lock)]
async fn test_mock_daemon_session_and_mode_endpoints() {
    // Serialize against the other VST_DAEMON_URL-mutating mock test (3.T6).
    // Intentionally held for the whole test: it guards the process-global
    // VST_DAEMON_URL env var, not a real async resource, so holding it across
    // awaits is the point, not a deadlock risk.
    let _url_guard = MOCK_DAEMON_URL_LOCK.lock().unwrap();
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
            "/api/modes",
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
            "/api/modes/:id",
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
            "/api/sessions",
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
            "/api/sessions/:id",
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
            "/api/sessions/:id/output",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "id": id,
                    "output": "line 1\nline 2\n"
                }))
            }),
        )
        .route(
            "/api/sessions/:id/transcript",
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
            "/api/sessions/:id/reset",
            post(
                |Path(id): Path<String>, Json(_body): Json<serde_json::Value>| async move {
                    Json(json!({
                        "ok": true,
                        "archivedSessionId": id,
                        "newSessionId": "sess-new-2",
                        "carryOver": "none"
                    }))
                },
            ),
        )
        .route(
            "/api/sessions/:id/handoff",
            post(|Path(_id): Path<String>| async move {
                Json(json!({
                    "ok": true,
                    "handoffSummary": "summary of work done"
                }))
            }),
        )
        .route(
            "/api/sessions/:id/rename",
            patch(|Path(_id): Path<String>, Json(body): Json<serde_json::Value>| async move {
                let name = body.get("name").and_then(|v| v.as_str()).map(ToString::to_string);
                Json(json!({
                    "ok": true,
                    "name": name
                }))
            }),
        )
        .route(
            "/api/sessions/:id/chat/stop",
            post(|Path(_id): Path<String>| async move {
                Json(json!({ "ok": true }))
            }),
        )
        .route(
            "/api/sessions/:id/resume",
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
    let sess_create_res = run_agent_create(AgentCreateOptions {
        worktree_id: "wt-1".to_string(),
        project_id: None,
        mode: None,
        prompt: None,
        prompt_file: None,
        channel: Some("json".to_string()),
        parent: None,
        no_parent: true,
    })
    .await;
    assert!(sess_create_res.is_ok());

    // Verify POST /sessions 404
    let sess_create_404 = run_agent_create(AgentCreateOptions {
        worktree_id: "wt-missing".to_string(),
        project_id: None,
        mode: None,
        prompt: None,
        prompt_file: None,
        channel: None,
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

    // Verify POST /sessions/:id/reset via `start-fresh`
    let start_fresh_opts = parse_session_start_fresh_options(&[
        "sess-wt-1".to_string(),
        "--prompt=reprompt".to_string(),
    ])
    .expect("parse ok");
    let sess_start_fresh_res = run_session_start_fresh(start_fresh_opts).await;
    assert!(sess_start_fresh_res.is_ok(), "{sess_start_fresh_res:?}");

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

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn test_mock_agent_create_channel_body_omitted_vs_explicit() {
    // Serialize against the other VST_DAEMON_URL-mutating mock test.
    // Intentionally held for the whole test; see comment on the sibling test
    // above for why this is safe (guards a global env var, not an async
    // resource).
    let _url_guard = MOCK_DAEMON_URL_LOCK.lock().unwrap();
    // 3.T6 (a)+(b): a body-capturing POST /api/sessions mock. Omitting
    // --channel must send a body where the channel key is ABSENT (the daemon
    // resolves the effective default); explicit --channel=tmux must send
    // "channel":"tmux" (regression guard against the override path silently
    // degrading to None).
    let captured: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({ "ok": true, "version": "0.1.0", "port": 8888, "uptime": 1 }))
            }),
        )
        .route(
            "/api/sessions",
            post({
                let captured = captured.clone();
                move |Json(body): Json<serde_json::Value>| {
                    let captured = captured.clone();
                    async move {
                        *captured.lock().unwrap() = Some(body);
                        Json(json!({
                            "id": "sess-1",
                            "worktreeId": "wt-1",
                            "projectId": "p1",
                            "isMain": false,
                            "type": "agent",
                            "tmuxName": "vst_sess1",
                            "useTmux": false,
                            "channel": "json",
                            "state": "idle",
                            "lifecycleState": "idle",
                            "createdAt": "2026-09-15T00:00:00Z",
                            "sortOrder": 1.0
                        }))
                    }
                }
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
    env::set_var("VST_DAEMON_URL", &base_url);

    // (a) omitted --channel -> the channel key is absent in the request body.
    let r = run_agent_create(AgentCreateOptions {
        worktree_id: "wt-1".to_string(),
        project_id: None,
        mode: None,
        prompt: None,
        prompt_file: None,
        channel: None,
        parent: None,
        no_parent: true,
    })
    .await;
    assert!(r.is_ok());
    let body = captured.lock().unwrap().clone().unwrap();
    assert!(
        body.get("channel").is_none(),
        "omitted --channel must send an ABSENT channel key, got: {body}"
    );

    // (b) explicit --channel=tmux -> "channel":"tmux" is sent.
    *captured.lock().unwrap() = None;
    let r = run_agent_create(AgentCreateOptions {
        worktree_id: "wt-1".to_string(),
        project_id: None,
        mode: None,
        prompt: None,
        prompt_file: None,
        channel: Some("tmux".to_string()),
        parent: None,
        no_parent: true,
    })
    .await;
    assert!(r.is_ok());
    let body = captured.lock().unwrap().clone().unwrap();
    assert_eq!(body.get("channel").and_then(|v| v.as_str()), Some("tmux"));

    env::remove_var("VST_DAEMON_URL");
}

/// 3.T2: the CLI sends the new `ResetBody` fields, and a 409 from a summary
/// reset is surfaced with the "nothing changed" retry text.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn test_start_fresh_body_and_summary_failure() {
    let _url_guard = MOCK_DAEMON_URL_LOCK.lock().unwrap();
    let captured: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({ "ok": true, "version": "0.1.0", "port": 8888, "uptime": 1 }))
            }),
        )
        .route(
            "/api/sessions/:id/reset",
            post({
                let captured = captured.clone();
                move |Path(id): Path<String>, Json(body): Json<serde_json::Value>| {
                    let captured = captured.clone();
                    async move {
                        if id == "s-409" {
                            return (
                                StatusCode::CONFLICT,
                                Json(json!({
                                    "error": "The summary was not produced",
                                    "code": "handoff_failed"
                                })),
                            );
                        }
                        if id == "s-404" {
                            return (
                                StatusCode::NOT_FOUND,
                                Json(json!({ "error": "Session not found" })),
                            );
                        }
                        *captured.lock().unwrap() = Some(body);
                        (
                            StatusCode::OK,
                            Json(json!({
                                "ok": true,
                                "archivedSessionId": id,
                                "newSessionId": "s-new",
                                "carryOver": "summary",
                                "breakKind": "reset"
                            })),
                        )
                    }
                }
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

    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(
        vst_dir.join("config.json"),
        format!(r#"{{"port": {}}}"#, addr.port()),
    )
    .expect("write config");
    env::set_var("VST_DAEMON_URL", &base_url);

    // Summary + inline text: `--summary-file` content goes out as `handoffText`.
    let summary_path = tmp.path().join("summary.md");
    fs::write(&summary_path, "the summary").expect("write summary");
    let opts = parse_session_start_fresh_options(&[
        "s-wt-1".to_string(),
        "--carry=summary".to_string(),
        format!("--summary-file={}", summary_path.display()),
        "--prompt=go".to_string(),
        "--queued=drop".to_string(),
        "--channel=json".to_string(),
    ])
    .expect("parse ok");
    let res = run_session_start_fresh(opts).await;
    assert!(res.is_ok());

    let body = captured.lock().unwrap().clone().expect("body captured");
    assert_eq!(body["carryOver"], json!("summary"));
    assert_eq!(body["whenBusy"], json!("stop"));
    assert_eq!(body["queued"], json!("drop"));
    assert_eq!(body["channel"], json!("json"));
    assert_eq!(body["prompt"], json!("go"));
    assert_eq!(body["handoffText"], json!("the summary"));
    assert!(
        body.get("handoff").is_none(),
        "the CLI must not send the legacy `handoff` flag"
    );

    // 409 handoff_failed -> the fixed retry text, exit 1.
    let opts = parse_session_start_fresh_options(&[
        "s-409".to_string(),
        "--carry=summary".to_string(),
        format!("--summary-file={}", summary_path.display()),
    ])
    .expect("parse ok");
    let (msg, code) = run_session_start_fresh(opts).await.expect_err("409");
    assert_eq!(code, 1);
    assert_eq!(msg, SUMMARY_FAILED);

    // 404 -> exit 2.
    let opts = parse_session_start_fresh_options(&["s-404".to_string()]).expect("parse ok");
    let (_, code) = run_session_start_fresh(opts).await.expect_err("404");
    assert_eq!(code, 2);

    // `--json` still returns Ok (the shape is unit-tested via `result_json`).
    let opts = parse_session_start_fresh_options(&["s-wt-1".to_string(), "--json".to_string()])
        .expect("parse ok");
    assert!(run_session_start_fresh(opts).await.is_ok());

    env::remove_var("VST_DAEMON_URL");
}

/// 3.T2: `switch` refuses a no-op before archiving anything, and a real switch
/// sends `modeId`.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn test_switch_same_mode_rejected_and_mode_sent() {
    let _url_guard = MOCK_DAEMON_URL_LOCK.lock().unwrap();
    let captured: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({ "ok": true, "version": "0.1.0", "port": 8888, "uptime": 1 }))
            }),
        )
        .route(
            "/api/sessions/:id",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "id": id,
                    "worktreeId": "wt-1",
                    "projectId": "p1",
                    "isMain": true,
                    "type": "agent",
                    "modeId": "m-1",
                    "modeIcon": null,
                    "name": null,
                    "nameSource": null,
                    "tmuxName": format!("vst_{id}"),
                    "useTmux": false,
                    "channel": "json",
                    "state": "idle",
                    "lifecycleState": "idle",
                    "createdAt": "2026-09-15T00:00:00Z",
                    "pinnedAt": null,
                    "archivedAt": null,
                    "sortOrder": 1.0,
                    "handoffSummary": null,
                    "parentSessionId": null,
                    "supersededBy": null,
                    "pr": null,
                    "draftPrompt": null,
                    "draftConfig": null
                }))
            }),
        )
        .route(
            "/api/modes",
            get(|| async {
                Json(json!([
                    {
                        "id": "m-1",
                        "name": "opus-planner",
                        "cli": "claude",
                        "context": "",
                        "createdAt": "2026-09-15T00:00:00Z"
                    },
                    {
                        "id": "m-2",
                        "name": "sonnet-implementer",
                        "cli": "claude",
                        "context": "",
                        "createdAt": "2026-09-15T00:00:00Z"
                    }
                ]))
            }),
        )
        .route(
            "/api/sessions/:id/reset",
            post({
                let captured = captured.clone();
                move |Path(id): Path<String>, Json(body): Json<serde_json::Value>| {
                    let captured = captured.clone();
                    async move {
                        *captured.lock().unwrap() = Some(body);
                        Json(json!({
                            "ok": true,
                            "archivedSessionId": id,
                            "newSessionId": "s-new",
                            "carryOver": "transcript",
                            "breakKind": "switch"
                        }))
                    }
                }
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

    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(
        vst_dir.join("config.json"),
        format!(r#"{{"port": {}}}"#, addr.port()),
    )
    .expect("write config");
    env::set_var("VST_DAEMON_URL", &base_url);

    // Same mode (id or name) -> refused, no POST.
    let opts =
        parse_session_switch_options(&["s-wt-1".to_string(), "--mode=opus-planner".to_string()])
            .expect("parse ok");
    let (msg, code) = run_session_switch(opts).await.expect_err("same mode");
    assert_eq!(code, 1);
    assert_eq!(msg, "Already on mode opus-planner. Pick another mode.");
    assert!(
        captured.lock().unwrap().is_none(),
        "must not archive anything"
    );

    // A different mode -> POST with `modeId`.
    let opts = parse_session_switch_options(&[
        "s-wt-1".to_string(),
        "--mode=sonnet-implementer".to_string(),
        "--carry=transcript".to_string(),
    ])
    .expect("parse ok");
    assert!(run_session_switch(opts).await.is_ok());
    let body = captured.lock().unwrap().clone().expect("body captured");
    assert_eq!(body["modeId"], json!("sonnet-implementer"));
    assert_eq!(body["carryOver"], json!("transcript"));

    env::remove_var("VST_DAEMON_URL");
}

/// 3.T2: `previous` walks a 3-session chain over the real `/api/sessions` route.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn test_previous_walks_chain_over_http() {
    let _url_guard = MOCK_DAEMON_URL_LOCK.lock().unwrap();

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({ "ok": true, "version": "0.1.0", "port": 8888, "uptime": 1 }))
            }),
        )
        .route(
            "/api/sessions",
            get(|| async {
                // Compact literal builder: every field `Session` requires.
                let sess = |id: &str,
                            mode: &str,
                            superseded: Option<&str>,
                            archived: Option<&str>,
                            summary: Option<&str>| {
                    json!({
                        "id": id,
                        "worktreeId": "wt-1",
                        "projectId": "p1",
                        "isMain": true,
                        "type": "agent",
                        "modeId": mode,
                        "modeIcon": null,
                        "name": null,
                        "nameSource": null,
                        "tmuxName": format!("vst_{id}"),
                        "useTmux": false,
                        "channel": "json",
                        "state": if archived.is_some() { "exited" } else { "idle" },
                        "lifecycleState": if archived.is_some() { "exited" } else { "idle" },
                        "createdAt": "2026-09-15T00:00:00Z",
                        "pinnedAt": null,
                        "archivedAt": archived,
                        "sortOrder": 1.0,
                        "handoffSummary": summary,
                        "parentSessionId": null,
                        "supersededBy": superseded,
                        "pr": null,
                        "draftPrompt": null,
                        "draftConfig": null
                    })
                };
                Json(json!([
                    sess(
                        "s-old",
                        "m-1",
                        Some("s-mid"),
                        Some("2026-09-15T00:00:00Z"),
                        Some("summary old")
                    ),
                    sess(
                        "s-mid",
                        "m-2",
                        Some("s-new"),
                        Some("2026-09-16T00:00:00Z"),
                        None
                    ),
                    sess("s-new", "m-2", None, None, None)
                ]))
            }),
        )
        .route(
            "/api/modes",
            get(|| async {
                Json(json!([
                    {
                        "id": "m-1",
                        "name": "opus-planner",
                        "cli": "claude",
                        "context": "",
                        "createdAt": "2026-09-15T00:00:00Z"
                    },
                    {
                        "id": "m-2",
                        "name": "sonnet-implementer",
                        "cli": "claude",
                        "context": "",
                        "createdAt": "2026-09-15T00:00:00Z"
                    }
                ]))
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

    let tmp = tempdir().expect("tempdir");
    let vst_dir = tmp.path().join(".vibe-station");
    fs::create_dir_all(&vst_dir).expect("mkdir");
    fs::write(
        vst_dir.join("config.json"),
        format!(r#"{{"port": {}}}"#, addr.port()),
    )
    .expect("write config");
    env::set_var("VST_DAEMON_URL", &base_url);

    let opts = parse_session_previous_options(&["s-new".to_string()]).expect("parse ok");
    assert!(run_session_previous(opts).await.is_ok());

    let opts = parse_session_previous_options(&["s-new".to_string(), "--json".to_string()])
        .expect("parse ok");
    assert!(run_session_previous(opts).await.is_ok());

    // Unknown session -> exit 2.
    let opts = parse_session_previous_options(&["nope".to_string()]).expect("parse ok");
    let (_, code) = run_session_previous(opts)
        .await
        .expect_err("unknown session");
    assert_eq!(code, 2);

    env::remove_var("VST_DAEMON_URL");
}
