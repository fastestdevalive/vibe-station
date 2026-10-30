//! Claude task detection against fixtures (task-tray 1.T10 / 1.T11).
//!
//! `claude_background_bash_*`: F2 text. `claude_subagent_*`: SYNTHETIC — built
//! from the plan's F4/F9 shapes because no live subagent transcript was
//! available; replace with a live capture when one is.

use std::path::PathBuf;

use serde_json::Value;
use vst_agents::claude::create_claude_plugin;
use vst_agents::claude_tasks::{claude_enrich_hook, claude_task_signal_event};
use vst_agents::AgentPlugin;
use vst_tasks::TaskObservation as O;
use vst_types::{NormalizedEvent, NormalizedEventKind, TaskState};

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude_tasks")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p:?}: {e}")))
        .unwrap()
}

fn event(v: &Value) -> NormalizedEvent {
    serde_json::from_value(v["event"].clone()).expect("fixture event deserialises")
}

fn obs(name: &str) -> Vec<O> {
    create_claude_plugin().task_observations(&event(&fixture(name)))
}

const BG_PATH: &str =
    "/tmp/claude-1000/-home-dev-vibe-station/9f2c1d34-5a6b-4c7d-8e9f-0a1b2c3d4e5f/tasks/be00epro0.output";

#[test]
fn real_background_bash_result_yields_id_and_path() {
    assert_eq!(
        obs("claude_background_bash_tool_result.json"),
        vec![
            O::CommandBackgrounded {
                tool_id: "toolu_bg1".into(),
                task_id: "be00epro0".into(),
                output_path: Some(BG_PATH.into()),
            },
            // terminal status is also reported (registry ignores unknown ids)
            O::SubagentFinished {
                tool_id: "toolu_bg1".into(),
                ok: true,
                final_text: Some(format!(
                    "Command running in background with ID: be00epro0. Output is being written to: {BG_PATH}. You will be notified when it completes."
                )),
            },
        ]
    );
}

#[test]
fn background_launch_refinement_yields_command_launched() {
    assert_eq!(
        obs("claude_background_bash_launch.json"),
        vec![O::CommandLaunched {
            tool_id: "toolu_bg1".into(),
            command: "sleep 90; echo done".into(),
        }]
    );
}

#[test]
fn background_bash_variants_yield_exact_observations_or_none() {
    let all = fixture("claude_background_bash_variants.json");
    let plugin = create_claude_plugin();
    let mut seen = 0;
    for case in all["variants"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got: Vec<O> = plugin
            .task_observations(&event(case))
            .into_iter()
            // The terminal-status passthrough is covered above; here only the
            // command-related observations matter.
            .filter(|o| !matches!(o, O::SubagentFinished { .. }))
            .collect();
        let want: Vec<O> = match name {
            "missing_path" => vec![O::CommandBackgrounded {
                tool_id: "t2".into(),
                task_id: "abc123".into(),
                output_path: None,
            }],
            "punctuation_in_id" => vec![O::CommandBackgrounded {
                tool_id: "t3".into(),
                task_id: "b-1x_2".into(),
                output_path: Some("/tmp/claude-1000/p/u/tasks/b-1x_2.output".into()),
            }],
            "code_fenced" => vec![O::CommandBackgrounded {
                tool_id: "t4".into(),
                task_id: "fenced1".into(),
                output_path: Some("/tmp/claude-1000/p/u/tasks/fenced1.output".into()),
            }],
            "launch_kind_absent_on_refinement" => vec![O::CommandLaunched {
                tool_id: "t11".into(),
                command: "npm run dev".into(),
            }],
            // ambiguous / error / no marker / not Bash / flag missing or false / not a tool event
            "two_ids"
            | "error_result"
            | "no_marker"
            | "launch_without_run_in_background"
            | "non_bash_with_flag"
            | "launch_flag_false"
            | "not_a_tool_event" => vec![],
            other => panic!("fixture case without expectation: {other}"),
        };
        assert_eq!(got, want, "case {name}");
        seen += 1;
    }
    assert_eq!(seen, 11);
}

#[test]
fn subagent_fixtures_are_marked_synthetic() {
    for f in [
        "claude_subagent_started.json",
        "claude_subagent_nested.json",
        "claude_subagent_finished_ok.json",
        "claude_subagent_finished_failed.json",
        "claude_subagent_background_launch.json",
    ] {
        assert_eq!(fixture(f)["_synthetic"], Value::Bool(true), "{f}");
    }
}

#[test]
fn subagent_start_is_detected_from_input_shape_not_tool_name() {
    let ev = event(&fixture("claude_subagent_started.json"));
    // `tool_name` is the ACP title, never "Task"/"Agent" (F9).
    assert_eq!(ev.tool_name.as_deref(), Some("Review the diff"));
    assert_eq!(
        create_claude_plugin().task_observations(&ev),
        vec![O::SubagentStarted {
            tool_id: "toolu_sub1".into(),
            label: "Review the diff".into(),
            background: false,
        }]
    );
}

#[test]
fn nested_call_with_parent_id_yields_a_nested_line_only() {
    let got = obs("claude_subagent_nested.json");
    assert_eq!(got.len(), 1, "{got:?}");
    match &got[0] {
        O::SubagentNested {
            parent_tool_id,
            line,
        } => {
            assert_eq!(parent_tool_id, "toolu_sub1");
            assert!(line.starts_with("Read"), "{line}");
            assert!(line.contains("main.rs"), "{line}");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn terminal_results_yield_finished_ok_and_failed() {
    assert_eq!(
        obs("claude_subagent_finished_ok.json"),
        vec![O::SubagentFinished {
            tool_id: "toolu_sub1".into(),
            ok: true,
            final_text: Some("The diff looks fine.".into()),
        }]
    );
    assert_eq!(
        obs("claude_subagent_finished_failed.json"),
        vec![O::SubagentFinished {
            tool_id: "toolu_sub1".into(),
            ok: false,
            final_text: Some("Subagent crashed".into()),
        }]
    );
}

#[test]
fn background_subagent_launch_is_flagged_background_with_fallback_label() {
    assert_eq!(
        obs("claude_subagent_background_launch.json"),
        vec![O::SubagentStarted {
            tool_id: "toolu_sub2".into(),
            label: "Long refactor".into(),
            background: true,
        }]
    );
}

#[test]
fn other_plugins_report_no_tasks_by_default() {
    let ev = event(&fixture("claude_subagent_started.json"));
    assert!(vst_agents::codex::create_codex_plugin()
        .task_observations(&ev)
        .is_empty());
    assert!(vst_agents::opencode::create_opencode_plugin()
        .task_observations(&ev)
        .is_empty());
}

#[test]
fn enrich_hook_copies_parent_tool_use_id_and_nothing_else() {
    use agent_client_protocol::schema::v1::{SessionUpdate, ToolCall, ToolCallId};
    let mut call = ToolCall::new(ToolCallId::new("toolu_nest1"), "Read `a.rs`");
    let mut meta = serde_json::Map::new();
    meta.insert(
        "claudeCode".into(),
        serde_json::json!({ "parentToolUseId": "toolu_sub1", "toolName": "Read" }),
    );
    call.meta = Some(meta);
    let upd = SessionUpdate::ToolCall(call);
    let base = NormalizedEvent {
        tool_name: Some("Read `a.rs`".into()),
        ..NormalizedEvent::default()
    };
    let hook = claude_enrich_hook();
    let out = hook(&upd, &base).expect("enriched");
    assert_eq!(out.parent_tool_use_id.as_deref(), Some("toolu_sub1"));
    assert_eq!(out.tool_name, base.tool_name, "tool_name untouched");

    // No parent id -> no replacement.
    let plain = SessionUpdate::ToolCall(ToolCall::new(ToolCallId::new("x"), "t"));
    assert!(hook(&plain, &base).is_none());
}

#[test]
fn result_row_yields_turn_settled_and_text_or_usage_rows_yield_nothing() {
    assert_eq!(obs("claude_turn_result.json"), vec![O::TurnSettled]);
    let plugin = create_claude_plugin();
    for kind in ["text", "usage", "thinking"] {
        let mut v = fixture("claude_turn_result.json");
        v["event"]["kind"] = Value::String(kind.into());
        assert_eq!(plugin.task_observations(&event(&v)), vec![], "{kind}");
    }
}

/// The persisted `Result` row carries NO stop reason (`acp_run_turn.rs` emits
/// it for end_turn, refusal, max_tokens and an adapter/watchdog-answered
/// `cancelled` alike, with or without usage); a failed turn emits an `error`
/// row and no `Result`; a user cancel returns before any `Result`. So every
/// `Result` is treated as a settle: see the `claude_tasks.rs` module docs.
#[test]
fn every_result_row_settles_but_error_rows_do_not() {
    let plugin = create_claude_plugin();
    // Normal (usage present) and cancelled/watchdog shape (no usage).
    for usage in [true, false] {
        let mut v = fixture("claude_turn_result.json");
        if !usage {
            v["event"]["usage"] = Value::Null;
        }
        assert_eq!(
            plugin.task_observations(&event(&v)),
            vec![O::TurnSettled],
            "usage={usage}"
        );
    }
    let mut v = fixture("claude_turn_result.json");
    v["event"]["kind"] = Value::String("error".into());
    assert_eq!(plugin.task_observations(&event(&v)), vec![]);
}

// --- raw SDK task signals (adapter 0.98.0 `emitRawSDKMessages`) ---
//
// `raw_*.json` are the `params` of `_claude/sdkMessage` notifications exactly as
// the REAL adapter emitted them (scripts/claude-acp-raw-harness).

const RAW: &str = "_claude/sdkMessage";

fn signal(name: &str) -> NormalizedEvent {
    claude_task_signal_event(RAW, &fixture(name)).unwrap_or_else(|| panic!("{name}: no signal"))
}

fn signal_obs(name: &str) -> Vec<O> {
    create_claude_plugin().task_observations(&signal(name))
}

const RAW_FIXTURES: [&str; 12] = [
    "raw_task_started_bash.json",
    "raw_task_started_ambient.json",
    "raw_task_started_monitor.json",
    "raw_task_started_agent.json",
    "raw_task_updated_running.json",
    "raw_task_updated_paused.json",
    "raw_task_updated_backgrounded.json",
    "raw_task_updated_killed.json",
    "raw_task_updated_failed.json",
    "raw_task_notification_completed.json",
    "raw_task_notification_failed.json",
    "raw_task_notification_worker_restart.json",
];

/// 8.T1: every real payload becomes a `TaskSignal` row without the sensitive/bulky fields.
#[test]
fn raw_messages_become_whitelisted_task_signal_rows() {
    for name in RAW_FIXTURES {
        let ev = signal(name);
        assert_eq!(ev.kind, NormalizedEventKind::TaskSignal, "{name}");
        let sig = ev.task_signal.as_ref().unwrap().as_object().unwrap();
        for banned in [
            "prompt",
            "usage",
            "uuid",
            "session_id",
            "resource_links",
            "type",
        ] {
            assert!(!sig.contains_key(banned), "{name} leaks {banned}");
        }
        assert!(
            sig["task_id"].as_str().is_some_and(|s| !s.is_empty()),
            "{name}"
        );
    }
    // The agent fixture really carried a prompt on the wire; it must be stripped.
    assert!(fixture("raw_task_started_agent.json")["message"]["prompt"].is_string());
    let sig = signal("raw_task_started_bash.json").task_signal.unwrap();
    assert_eq!(sig["subtype"], "task_started");
    assert_eq!(sig["task_type"], "local_bash");
    assert_eq!(sig["is_backgrounded"], true);
    assert_eq!(sig["tool_use_id"], "toolu_bash01");
}

#[test]
fn only_the_three_task_system_messages_on_the_raw_method_are_accepted() {
    let p = fixture("raw_task_started_bash.json");
    assert!(claude_task_signal_event("_claude/other", &p).is_none());
    assert!(claude_task_signal_event("session/update", &p).is_none());
    let mut other = p.clone();
    other["message"]["type"] = "assistant".into();
    assert!(claude_task_signal_event(RAW, &other).is_none());
    let mut other = p.clone();
    other["message"]["subtype"] = "status".into();
    assert!(claude_task_signal_event(RAW, &other).is_none());
    let mut no_id = p.clone();
    no_id["message"].as_object_mut().unwrap().remove("task_id");
    assert!(claude_task_signal_event(RAW, &no_id).is_none());
    assert!(claude_task_signal_event(RAW, &serde_json::json!({"message": 3})).is_none());
    assert!(claude_task_signal_event(RAW, &serde_json::json!(null)).is_none());
    // Oversized free text is clipped.
    let mut big = p;
    big["message"]["description"] = "d".repeat(5_000).into();
    let sig = claude_task_signal_event(RAW, &big)
        .unwrap()
        .task_signal
        .unwrap();
    assert_eq!(sig["description"].as_str().unwrap().chars().count(), 200);
}

/// 8.T2: observations exactly per the plan's A-D6 table.
#[test]
fn signal_rows_yield_confirmed_and_ended_per_the_table() {
    assert_eq!(
        signal_obs("raw_task_started_bash.json"),
        vec![O::Confirmed {
            id: "bx1a2b3c4".into(),
            tool_id: Some("toolu_bash01".into()),
            paused: false
        }]
    );
    assert_eq!(
        signal_obs("raw_task_started_agent.json"),
        vec![O::Confirmed {
            id: "agent-7f".into(),
            tool_id: Some("toolu_agent01".into()),
            paused: false
        }]
    );
    assert!(signal_obs("raw_task_started_monitor.json").is_empty());
    assert!(signal_obs("raw_task_started_ambient.json").is_empty());
    assert_eq!(
        signal_obs("raw_task_updated_running.json"),
        vec![O::Confirmed {
            id: "bx1a2b3c4".into(),
            tool_id: None,
            paused: false
        }]
    );
    assert_eq!(
        signal_obs("raw_task_updated_paused.json"),
        vec![O::Confirmed {
            id: "bx1a2b3c4".into(),
            tool_id: None,
            paused: true
        }]
    );
    assert_eq!(
        signal_obs("raw_task_updated_backgrounded.json"),
        vec![O::Confirmed {
            id: "bx9".into(),
            tool_id: None,
            paused: false
        }]
    );
    assert_eq!(
        signal_obs("raw_task_updated_killed.json"),
        vec![O::Ended {
            id: "bx2".into(),
            tool_id: None,
            state: TaskState::Stopped,
            reason: None
        }]
    );
    assert_eq!(
        signal_obs("raw_task_updated_failed.json"),
        vec![O::Ended {
            id: "agent-7f".into(),
            tool_id: None,
            state: TaskState::Failed,
            reason: Some("boom".into())
        }]
    );
    assert_eq!(
        signal_obs("raw_task_notification_completed.json"),
        vec![O::Ended {
            id: "bx1a2b3c4".into(),
            tool_id: Some("toolu_bash01".into()),
            state: TaskState::Done,
            reason: None
        }]
    );
    assert_eq!(
        signal_obs("raw_task_notification_failed.json"),
        vec![O::Ended {
            id: "bx3".into(),
            tool_id: Some("toolu_bash03".into()),
            state: TaskState::Failed,
            reason: None
        }]
    );
    assert_eq!(
        signal_obs("raw_task_notification_worker_restart.json"),
        vec![O::Ended {
            id: "agent-7f".into(),
            tool_id: Some("toolu_agent01".into()),
            state: TaskState::Stopped,
            reason: None
        }]
    );
}

/// Tolerance: a foreground Bash start, a missing patch, an unknown status and a
/// non-signal row all yield nothing (the probe fallback stays in charge).
#[test]
fn unexpected_signal_shapes_yield_no_observations() {
    let plugin = create_claude_plugin();
    let mk = |sig: Value| {
        let mut e = NormalizedEvent::default();
        e.kind = NormalizedEventKind::TaskSignal;
        e.task_signal = Some(sig);
        plugin.task_observations(&e)
    };
    use serde_json::json;
    assert!(
        mk(json!({"subtype": "task_started", "task_id": "x", "task_type": "local_bash"}))
            .is_empty()
    );
    assert!(
        mk(json!({"subtype": "task_started", "task_id": "x", "task_type": "local_agent"}))
            .is_empty()
    );
    assert!(mk(json!({"subtype": "task_updated", "task_id": "x"})).is_empty());
    assert!(
        mk(json!({"subtype": "task_updated", "task_id": "x", "patch": {"status": "weird"}}))
            .is_empty()
    );
    assert!(
        mk(json!({"subtype": "task_notification", "task_id": "x", "status": "weird"})).is_empty()
    );
    assert!(mk(json!({"subtype": "nope", "task_id": "x"})).is_empty());
    assert!(mk(json!("not an object")).is_empty());
    let mut e = NormalizedEvent::default();
    e.kind = NormalizedEventKind::TaskSignal;
    assert!(
        plugin.task_observations(&e).is_empty(),
        "signal kind without payload"
    );
}
