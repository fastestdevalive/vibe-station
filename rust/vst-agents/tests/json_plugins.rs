//! Behavior contract for the per-plugin stream-json parsers — ports
//! `daemon/src/__tests__/jsonPlugins.test.ts` (3.T1).
//!
//! Each plugin's parser maps its CLI's native event stream into
//! [`vst_types::NormalizedEvent`]s with the correct `provider` + usage mapping
//! (Decision 3); the core never parses raw CLI JSON.

mod common;

use vst_agents::agy::{create_agy_stream_state, parse_agy_stream_line};
use vst_agents::cursor::parse_cursor_stream_line;
use vst_agents::opencode::{parse_opencode_stream_line, OpencodeStreamState};
use vst_types::NormalizedEventKind;

const SID: &str = "sess-x";

fn kinds(evs: &[vst_types::NormalizedEvent]) -> Vec<NormalizedEventKind> {
    evs.iter().map(|e| e.kind).collect()
}

mod cursor_parser {
    use super::*;

    #[test]
    fn system_init_to_session_init() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"system","subtype":"init","session_id":"cur-1","model":"auto"}"#,
            SID,
        );
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].provider, vst_types::NormalizedEventProvider::Cursor);
        assert_eq!(evs[0].kind, NormalizedEventKind::SessionInit);
        assert_eq!(evs[0].model.as_deref(), Some("auto"));
        assert_eq!(evs[0].agent_chat_id.as_deref(), Some("cur-1"));
    }

    #[test]
    fn suppresses_user_echo() {
        assert!(parse_cursor_stream_line(r#"{"type":"user","text":"hi"}"#, SID).is_empty());
    }

    #[test]
    fn streams_thinking_delta() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"thinking","subtype":"delta","text":"pondering"}"#,
            SID,
        );
        assert_eq!(evs[0].provider, vst_types::NormalizedEventProvider::Cursor);
        assert_eq!(evs[0].kind, NormalizedEventKind::Thinking);
        assert_eq!(evs[0].text.as_deref(), Some("pondering"));
    }

    #[test]
    fn tool_call_started_and_completed_same_call_id() {
        let started = parse_cursor_stream_line(
            r#"{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}"#,
            SID,
        );
        assert_eq!(started[0].kind, NormalizedEventKind::ToolUse);
        assert_eq!(started[0].tool_id.as_deref(), Some("c1"));
        assert_eq!(started[0].tool_name.as_deref(), Some("shellToolCall"));
        assert_eq!(
            started[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("command").and_then(|c| c.as_str())),
            Some("ls")
        );

        let completed = parse_cursor_stream_line(
            r#"{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"result":"file.txt"}}}"#,
            SID,
        );
        assert_eq!(completed[0].kind, NormalizedEventKind::ToolResult);
        assert_eq!(completed[0].tool_id.as_deref(), Some("c1"));
        assert_eq!(
            completed[0]
                .tool_result
                .as_ref()
                .and_then(|t| t.content.as_deref()),
            Some("file.txt")
        );
    }

    #[test]
    fn result_success_usage_and_result_with_summed_tokens() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"result","subtype":"success","model":"auto","total_cost_usd":0.01,"usage":{"input_tokens":4,"output_tokens":6,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}"#,
            SID,
        );
        assert_eq!(
            kinds(&evs),
            vec![NormalizedEventKind::Usage, NormalizedEventKind::Result]
        );
        assert_eq!(evs[0].usage.as_ref().unwrap().total_tokens, 10);
        assert_eq!(evs[0].usage.as_ref().unwrap().cost_usd, Some(0.01));
        assert_eq!(evs[0].provider, vst_types::NormalizedEventProvider::Cursor);
    }

    #[test]
    fn reads_camel_case_usage_keys() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"result","subtype":"success","model":"auto","usage":{"inputTokens":4633,"outputTokens":359,"cacheReadTokens":22656,"cacheWriteTokens":0}}"#,
            SID,
        );
        let usage = evs
            .iter()
            .find(|e| e.kind == NormalizedEventKind::Usage)
            .unwrap()
            .usage
            .as_ref()
            .unwrap();
        assert_eq!(usage.input_tokens, 4633);
        assert_eq!(usage.output_tokens, 359);
        assert_eq!(usage.cache_read_tokens, 22656);
        assert_eq!(usage.cache_create_tokens, 0);
        assert_eq!(usage.total_tokens, 4633 + 359 + 22656);
    }

    #[test]
    fn tool_call_completed_failure_is_error() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"tool_call","subtype":"completed","call_id":"c9","tool_call":{"shellToolCall":{"result":{"failure":{"command":"cat /nope","exitCode":1,"stderr":"No such file"}}}}}"#,
            SID,
        );
        let ev = &evs[0];
        assert_eq!(ev.kind, NormalizedEventKind::ToolResult);
        assert_eq!(ev.tool_result.as_ref().unwrap().is_error, Some(true));
        assert!(ev
            .tool_result
            .as_ref()
            .unwrap()
            .content
            .as_deref()
            .unwrap()
            .contains("No such file"));
    }

    #[test]
    fn tool_call_completed_success_not_error() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"tool_call","subtype":"completed","call_id":"c8","tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok","exitCode":0}}}}}"#,
            SID,
        );
        let ev = &evs[0];
        assert_eq!(ev.tool_result.as_ref().unwrap().is_error, Some(false));
        assert!(ev
            .tool_result
            .as_ref()
            .unwrap()
            .content
            .as_deref()
            .unwrap()
            .contains("ok"));
    }

    #[test]
    fn picks_toolcall_key_with_sibling_keys() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"tool_call","subtype":"started","call_id":"c7","tool_call":{"toolCallId":"c7","startedAtMs":1234,"hookAdditionalContexts":[],"readToolCall":{"args":{"path":"a.txt"}}}}"#,
            SID,
        );
        let ev = &evs[0];
        assert_eq!(ev.kind, NormalizedEventKind::ToolUse);
        assert_eq!(ev.tool_name.as_deref(), Some("readToolCall"));
        assert_eq!(
            ev.tool_input
                .as_ref()
                .and_then(|v| v.get("path").and_then(|p| p.as_str())),
            Some("a.txt")
        );
    }

    #[test]
    fn result_error_emits_typed_error() {
        let evs = parse_cursor_stream_line(
            r#"{"type":"result","subtype":"error","model":"auto","result":"rate limited","usage":{"inputTokens":1,"outputTokens":1}}"#,
            SID,
        );
        assert_eq!(
            kinds(&evs),
            vec![
                NormalizedEventKind::Usage,
                NormalizedEventKind::Result,
                NormalizedEventKind::Error
            ]
        );
        let err = evs
            .iter()
            .find(|e| e.kind == NormalizedEventKind::Error)
            .unwrap();
        assert_eq!(err.text.as_deref(), Some("rate limited"));
        assert_eq!(err.provider, vst_types::NormalizedEventProvider::Cursor);
    }

    #[test]
    fn skips_malformed_lines() {
        assert!(parse_cursor_stream_line("not json {{", SID).is_empty());
    }
}

mod opencode_parser {
    use super::*;

    #[test]
    fn surfaces_session_id_as_session_init_once() {
        let mut state = OpencodeStreamState::default();
        let first = parse_opencode_stream_line(
            r#"{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"hello"}}"#,
            SID,
            &mut state,
        );
        assert_eq!(
            kinds(&first),
            vec![NormalizedEventKind::SessionInit, NormalizedEventKind::Text]
        );
        assert_eq!(
            first[0].provider,
            vst_types::NormalizedEventProvider::Opencode
        );
        assert_eq!(first[0].agent_chat_id.as_deref(), Some("ses_1"));

        let second = parse_opencode_stream_line(
            r#"{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"world"}}"#,
            SID,
            &mut state,
        );
        assert_eq!(kinds(&second), vec![NormalizedEventKind::Text]);
    }

    #[test]
    fn reasoning_and_tool_running_completed() {
        let mut state = OpencodeStreamState {
            init_emitted: true,
            ..Default::default()
        };
        let reasoning = parse_opencode_stream_line(
            r#"{"type":"reasoning","sessionID":"s","part":{"type":"reasoning","text":"hmm"}}"#,
            SID,
            &mut state,
        );
        assert_eq!(reasoning[0].kind, NormalizedEventKind::Thinking);
        assert_eq!(reasoning[0].text.as_deref(), Some("hmm"));

        let running = parse_opencode_stream_line(
            r#"{"type":"tool","sessionID":"s","part":{"type":"tool","tool":"bash","callID":"t1","state":{"status":"running","input":{"cmd":"ls"}}}}"#,
            SID,
            &mut state,
        );
        assert_eq!(running[0].kind, NormalizedEventKind::ToolUse);
        assert_eq!(running[0].tool_name.as_deref(), Some("bash"));
        assert_eq!(running[0].tool_id.as_deref(), Some("t1"));
        assert_eq!(
            running[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("cmd").and_then(|c| c.as_str())),
            Some("ls")
        );

        let done = parse_opencode_stream_line(
            r#"{"type":"tool","sessionID":"s","part":{"type":"tool","tool":"bash","callID":"t1","state":{"status":"completed","output":"ok"}}}"#,
            SID,
            &mut state,
        );
        assert_eq!(done[0].kind, NormalizedEventKind::ToolResult);
        assert_eq!(
            done[0]
                .tool_result
                .as_ref()
                .and_then(|t| t.content.as_deref()),
            Some("ok")
        );
    }

    #[test]
    fn terminal_only_tool_emits_tool_use_then_tool_result() {
        let mut state = OpencodeStreamState {
            init_emitted: true,
            ..Default::default()
        };
        let evs = parse_opencode_stream_line(
            r#"{"type":"tool","sessionID":"s","part":{"type":"tool","tool":"bash","callID":"t9","state":{"status":"completed","input":{"command":"ls -la"},"output":"total 0"}}}"#,
            SID,
            &mut state,
        );
        assert_eq!(
            kinds(&evs),
            vec![
                NormalizedEventKind::ToolUse,
                NormalizedEventKind::ToolResult
            ]
        );
        assert_eq!(evs[0].tool_name.as_deref(), Some("bash"));
        assert_eq!(evs[0].tool_id.as_deref(), Some("t9"));
        assert_eq!(
            evs[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("command").and_then(|c| c.as_str())),
            Some("ls -la")
        );
        assert_eq!(evs[1].tool_id.as_deref(), Some("t9"));
        assert_eq!(
            evs[1]
                .tool_result
                .as_ref()
                .and_then(|t| t.content.as_deref()),
            Some("total 0")
        );
    }

    #[test]
    fn does_not_duplicate_tool_use_after_running() {
        let mut state = OpencodeStreamState {
            init_emitted: true,
            ..Default::default()
        };
        parse_opencode_stream_line(
            r#"{"type":"tool","sessionID":"s","part":{"type":"tool","tool":"bash","callID":"t5","state":{"status":"running","input":{"c":1}}}}"#,
            SID,
            &mut state,
        );
        let done = parse_opencode_stream_line(
            r#"{"type":"tool","sessionID":"s","part":{"type":"tool","tool":"bash","callID":"t5","state":{"status":"completed","output":"ok"}}}"#,
            SID,
            &mut state,
        );
        assert_eq!(kinds(&done), vec![NormalizedEventKind::ToolResult]);
    }

    #[test]
    fn step_finish_stop_ends_turn_tool_calls_dropped() {
        let mut state = OpencodeStreamState {
            init_emitted: true,
            ..Default::default()
        };
        let between = parse_opencode_stream_line(
            r#"{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls"}}"#,
            SID,
            &mut state,
        );
        assert!(between.is_empty());

        let stop = parse_opencode_stream_line(
            r#"{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":3,"output":7,"cache":{"read":0,"write":0}}}}"#,
            SID,
            &mut state,
        );
        assert_eq!(
            kinds(&stop),
            vec![NormalizedEventKind::Usage, NormalizedEventKind::Result]
        );
        assert_eq!(stop[0].usage.as_ref().unwrap().total_tokens, 10);
        assert_eq!(
            stop[0].provider,
            vst_types::NormalizedEventProvider::Opencode
        );
    }
}

mod agy_parser {
    use super::*;

    #[test]
    fn init_event_to_session_init_with_fallback_model() {
        let line = r#"{"event":"init","conversation_id":"a56a04cd-66b1-44cb-b538-90be2387c438","init":{"cwd":"/tmp/agytest","tools":["run_command","view_file"],"permission_mode":"always-proceed"}}"#;
        let evs = parse_agy_stream_line(
            line,
            SID,
            &mut create_agy_stream_state(),
            Some("Gemini 3.1 Pro (High)"),
        );
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].provider, vst_types::NormalizedEventProvider::Agy);
        assert_eq!(evs[0].kind, NormalizedEventKind::SessionInit);
        assert_eq!(
            evs[0].agent_chat_id.as_deref(),
            Some("a56a04cd-66b1-44cb-b538-90be2387c438")
        );
        assert_eq!(evs[0].model.as_deref(), Some("Gemini 3.1 Pro (High)"));
    }

    #[test]
    fn agent_response_text_delta_active() {
        let line = r#"{"event":"step_update","step_update":{"conversation_id":"beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"I'll run both in parallel since they're independent!"}}"#;
        let evs = parse_agy_stream_line(line, SID, &mut create_agy_stream_state(), None);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].provider, vst_types::NormalizedEventProvider::Agy);
        assert_eq!(evs[0].kind, NormalizedEventKind::Text);
        assert_eq!(evs[0].role, Some(vst_types::Role::Assistant));
        assert_eq!(
            evs[0].text.as_deref(),
            Some("I'll run both in parallel since they're independent!")
        );
    }

    #[test]
    fn agent_response_done_carries_usage_not_surfaced() {
        let line = r#"{"event":"step_update","step_update":{"conversation_id":"beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":7.145,"usage":{"input_tokens":18684,"output_tokens":378,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":19062}}}"#;
        let evs = parse_agy_stream_line(line, SID, &mut create_agy_stream_state(), None);
        assert_eq!(kinds(&evs), vec![NormalizedEventKind::Text]);
        assert_eq!(evs[0].text.as_deref(), Some("\n"));
    }

    #[test]
    fn empty_text_delta_emits_nothing() {
        let line = r#"{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"agent_response","duration_seconds":4.18}}"#;
        assert!(parse_agy_stream_line(line, SID, &mut create_agy_stream_state(), None).is_empty());
    }

    #[test]
    fn tool_step_active_then_done() {
        let mut state = create_agy_stream_state();
        let active = r#"{"event":"step_update","step_update":{"conversation_id":"beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}"#;
        let active_evs = parse_agy_stream_line(active, SID, &mut state, None);
        assert_eq!(active_evs.len(), 1);
        assert_eq!(active_evs[0].kind, NormalizedEventKind::ToolUse);
        assert_eq!(active_evs[0].tool_name.as_deref(), Some("run_command"));
        assert_eq!(active_evs[0].tool_id.as_deref(), Some("3"));
        assert_eq!(
            active_evs[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("CommandLine").and_then(|c| c.as_str())),
            Some("ls -la")
        );

        let done = r#"{"event":"step_update","step_update":{"conversation_id":"beeaebcd-b396-4d7a-9fc3-a0c0ac83f1af","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.76,"tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"output":"total 8\r\ndrwxr-xr-x  2 gb gb 4096 Jul 15 15:17 .\r\n"}}}"#;
        let done_evs = parse_agy_stream_line(done, SID, &mut state, None);
        assert_eq!(kinds(&done_evs), vec![NormalizedEventKind::ToolResult]);
        assert_eq!(done_evs[0].tool_id.as_deref(), Some("3"));
        let tr = done_evs[0].tool_result.as_ref().unwrap();
        assert_eq!(
            tr.content.as_deref(),
            Some("total 8\r\ndrwxr-xr-x  2 gb gb 4096 Jul 15 15:17 .\r\n")
        );
        assert_eq!(tr.is_error, Some(false));
    }

    #[test]
    fn tool_step_done_only_synthesizes_both() {
        let done = r#"{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/x"},"output":"contents"}}}"#;
        let evs = parse_agy_stream_line(done, SID, &mut create_agy_stream_state(), None);
        assert_eq!(
            kinds(&evs),
            vec![
                NormalizedEventKind::ToolUse,
                NormalizedEventKind::ToolResult
            ]
        );
        assert_eq!(evs[0].tool_id.as_deref(), Some("5"));
        assert_eq!(evs[0].tool_name.as_deref(), Some("view_file"));
        assert_eq!(
            evs[0]
                .tool_input
                .as_ref()
                .and_then(|v| v.get("AbsolutePath").and_then(|a| a.as_str())),
            Some("/tmp/x")
        );
        assert_eq!(evs[1].tool_id.as_deref(), Some("5"));
        assert_eq!(
            evs[1].tool_result.as_ref().unwrap().content.as_deref(),
            Some("contents")
        );
    }

    #[test]
    fn tool_info_error_is_error() {
        let done = r#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{},"error":"permission denied"}}}"#;
        let evs = parse_agy_stream_line(done, SID, &mut create_agy_stream_state(), None);
        let result = evs
            .iter()
            .find(|e| e.kind == NormalizedEventKind::ToolResult)
            .unwrap();
        let tr = result.tool_result.as_ref().unwrap();
        assert_eq!(tr.content.as_deref(), Some("permission denied"));
        assert_eq!(tr.is_error, Some(true));
    }

    #[test]
    fn no_payload_step_types_dropped() {
        for step_type in ["user_input", "unknown", "checkpoint", "error_message"] {
            let line = format!(
                r#"{{"event":"step_update","step_update":{{"step_index":0,"state":"DONE","step_type":"{step_type}"}}}}"#
            );
            assert!(
                parse_agy_stream_line(&line, SID, &mut create_agy_stream_state(), None).is_empty(),
                "step_type {step_type} should be dropped"
            );
        }
    }

    #[test]
    fn result_success_usage_and_result() {
        let line = r#"{"event":"result","result":{"conversation_id":"a56a04cd-66b1-44cb-b538-90be2387c438","status":"SUCCESS","response":"4\n","duration_seconds":3.88,"num_turns":1,"usage":{"input_tokens":18772,"output_tokens":16,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18788}}}"#;
        let evs = parse_agy_stream_line(
            line,
            SID,
            &mut create_agy_stream_state(),
            Some("Gemini 3.1 Pro (High)"),
        );
        assert_eq!(
            kinds(&evs),
            vec![NormalizedEventKind::Usage, NormalizedEventKind::Result]
        );
        let usage = evs[0].usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, 18772);
        assert_eq!(usage.output_tokens, 16);
        assert_eq!(usage.cache_read_tokens, 0);
        assert_eq!(usage.cache_create_tokens, 0);
        assert_eq!(usage.total_tokens, 18788);
        assert_eq!(usage.model, "Gemini 3.1 Pro (High)");
        assert_eq!(evs[1].kind, NormalizedEventKind::Result);
        assert_eq!(evs[1].usage.as_ref().unwrap().total_tokens, 18788);
    }

    #[test]
    fn result_error_immediate_hard_fail() {
        let line = r#"{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \"totally-bogus-model\"): model not recognized","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}"#;
        let evs = parse_agy_stream_line(
            line,
            SID,
            &mut create_agy_stream_state(),
            Some("totally-bogus-model"),
        );
        assert_eq!(
            kinds(&evs),
            vec![
                NormalizedEventKind::Usage,
                NormalizedEventKind::Result,
                NormalizedEventKind::Error
            ]
        );
        let err = evs
            .iter()
            .find(|e| e.kind == NormalizedEventKind::Error)
            .unwrap();
        assert_eq!(err.provider, vst_types::NormalizedEventProvider::Agy);
        assert!(err
            .text
            .as_deref()
            .unwrap()
            .contains("invalid model selection"));
        assert!(evs
            .iter()
            .find(|e| e.kind == NormalizedEventKind::Result)
            .unwrap()
            .text
            .as_deref()
            .unwrap()
            .contains("invalid model selection"));
    }

    #[test]
    fn skips_malformed_lines() {
        let mut state = create_agy_stream_state();
        assert!(parse_agy_stream_line("not json {{", SID, &mut state, None).is_empty());
        assert!(parse_agy_stream_line("", SID, &mut state, None).is_empty());
        assert!(parse_agy_stream_line(r#"{"hello":"world"}"#, SID, &mut state, None).is_empty());
        assert!(
            parse_agy_stream_line(r#"{"event":"something_future"}"#, SID, &mut state, None)
                .is_empty()
        );
    }
}
