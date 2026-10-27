//! Tolerant parser for `agy --output-format stream-json` lines.
//!
//! This is the ONLY module in the crate that knows agy's wire shapes. It is
//! deliberately lenient: unknown fields, unknown `step_type`/`state`/`status`
//! values and future events are all tolerated (mapped to `Unknown`/`Other`),
//! never an error — a newer agy must not break the agent.
//!
//! Verified against agy 1.4.7. Real shapes:
//!
//! ```text
//! {"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[…]}}
//! {"event":"step_update","step_update":{…}}
//! {"event":"result","result":{…}}
//! ```

use serde_json::Value;

/// One parsed stdout frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// `{"event":"init", "conversation_id": …}` — agy's session start.
    ///
    /// `conversation_id` is optional so a malformed init is reported as such
    /// (`wait_init` fails fast) instead of being silently dropped.
    Init { conversation_id: Option<String> },
    /// `{"event":"step_update", "step_update": …}`.
    Step(Step),
    /// `{"event":"result", "result": …}` — the end of a turn.
    Result(AgyResult),
    /// A JSON object whose `event` we do not know (forward compatibility).
    Other,
}

/// `step_update.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    Active,
    Done,
    Error,
    Unknown,
}

/// `step_update.step_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepType {
    UserInput,
    AgentResponse,
    Tool,
    Checkpoint,
    ErrorMessage,
    SystemMessage,
    Unknown,
}

/// `step_update.tool_info` — `parameters`/`output`/`error` are kept raw: agy
/// emits `error` as an OBJECT (`{type, message}`) and `output` as a string or
/// object depending on the tool.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolInfo {
    pub parameters: Value,
    pub output: Option<Value>,
    pub error: Option<Value>,
}

/// Token usage as agy reports it. Every field defaults to 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgyUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
}

/// One `step_update`.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub conversation_id: Option<String>,
    pub step_index: i64,
    pub state: StepState,
    pub step_type: StepType,
    pub text_delta: Option<String>,
    pub tool_name: Option<String>,
    pub tool_info: Option<ToolInfo>,
    pub usage: Option<AgyUsage>,
}

/// `result.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultStatus {
    Success,
    Error,
    Unknown,
}

/// One `result` frame — the end of a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct AgyResult {
    pub conversation_id: Option<String>,
    pub status: ResultStatus,
    pub response: Option<String>,
    pub error: Option<String>,
    pub denied_actions: Vec<Value>,
    pub usage: Option<AgyUsage>,
}

/// Parse ONE stdout line. Returns `None` for empty/non-JSON/non-object lines
/// and for objects that carry no `event` string.
pub fn parse_line(line: &str) -> Option<Inbound> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    if !value.is_object() {
        return None;
    }
    let event = value.get("event").and_then(Value::as_str)?;
    Some(match event {
        "init" => Inbound::Init {
            conversation_id: nested_conversation_id(&value, "init"),
        },
        "step_update" => match value.get("step_update").filter(|v| v.is_object()) {
            Some(step) => Inbound::Step(parse_step(step)),
            None => Inbound::Other,
        },
        "result" => match value.get("result").filter(|v| v.is_object()) {
            Some(result) => Inbound::Result(parse_result(result)),
            None => Inbound::Other,
        },
        _ => Inbound::Other,
    })
}

/// The conversation id may ride on the envelope or inside the nested object.
fn nested_conversation_id(envelope: &Value, nested: &str) -> Option<String> {
    envelope
        .get("conversation_id")
        .and_then(Value::as_str)
        .or_else(|| {
            envelope
                .get(nested)
                .and_then(|o| o.get("conversation_id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn parse_step(step: &Value) -> Step {
    Step {
        conversation_id: step
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        step_index: step.get("step_index").and_then(Value::as_i64).unwrap_or(0),
        state: match step.get("state").and_then(Value::as_str) {
            Some("ACTIVE") => StepState::Active,
            Some("DONE") => StepState::Done,
            Some("ERROR") => StepState::Error,
            _ => StepState::Unknown,
        },
        step_type: match step.get("step_type").and_then(Value::as_str) {
            Some("user_input") => StepType::UserInput,
            Some("agent_response") => StepType::AgentResponse,
            Some("tool") => StepType::Tool,
            Some("checkpoint") => StepType::Checkpoint,
            Some("error_message") => StepType::ErrorMessage,
            Some("system_message") => StepType::SystemMessage,
            _ => StepType::Unknown,
        },
        text_delta: step
            .get("text_delta")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: step
            .get("tool_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_info: step
            .get("tool_info")
            .filter(|v| v.is_object())
            .map(|t| ToolInfo {
                parameters: t.get("parameters").cloned().unwrap_or(Value::Null),
                output: t.get("output").cloned(),
                error: t.get("error").cloned(),
            }),
        usage: step.get("usage").filter(|v| v.is_object()).map(parse_usage),
    }
}

fn parse_result(result: &Value) -> AgyResult {
    AgyResult {
        conversation_id: result
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: match result.get("status").and_then(Value::as_str) {
            Some("SUCCESS") => ResultStatus::Success,
            Some("ERROR") => ResultStatus::Error,
            _ => ResultStatus::Unknown,
        },
        response: result
            .get("response")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: result
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
        denied_actions: result
            .get("denied_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        usage: result
            .get("usage")
            .filter(|v| v.is_object())
            .map(parse_usage),
    }
}

fn parse_usage(usage: &Value) -> AgyUsage {
    AgyUsage {
        input_tokens: token_count(usage.get("input_tokens")),
        output_tokens: token_count(usage.get("output_tokens")),
        thinking_tokens: token_count(usage.get("thinking_tokens")),
        cache_read_tokens: token_count(usage.get("cache_read_tokens")),
        total_tokens: token_count(usage.get("total_tokens")),
    }
}

/// Token counts arrive as integers; be tolerant of floats/strings too.
///
/// A float is clamped to `>= 0` before the saturating cast — agy never emits
/// fractional or negative token counts.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn token_count(value: Option<&Value>) -> u64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(n) = value.as_u64() {
        return n;
    }
    if let Some(n) = value.as_i64() {
        return u64::try_from(n.max(0)).unwrap_or(0);
    }
    if let Some(n) = value.as_f64() {
        // float -> int casts saturate in Rust, so this cannot wrap.
        return n.max(0.0) as u64;
    }
    value
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Human-readable text for a `tool_info.error` value.
///
/// agy emits an OBJECT (`{"type":"TOOL_ERROR","message":"…"}`) for denied
/// tools and a plain string elsewhere; anything else falls back to compact
/// JSON so the reason is never lost.
pub fn error_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(map) => map
            .get("message")
            .and_then(Value::as_str)
            .map_or_else(|| compact(value), str::to_string),
        other => compact(other),
    }
}

/// Compact (single-line) JSON, or the raw scalar for non-JSON values.
#[must_use]
pub fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Build the single stdin line agy accepts for a user message.
///
/// agy's stream-json stdin accepts ONLY this event shape; anything else is
/// ignored (no steering, no permission replies).
#[must_use]
pub fn user_event(text: &str) -> String {
    serde_json::json!({
        "event": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }]
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(fixture: &'static str) -> Vec<&'static str> {
        fixture.lines().filter(|l| !l.trim().is_empty()).collect()
    }

    #[test]
    fn parses_init_new() {
        let fixture = include_str!("../tests/fixtures/init_new.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(
            parsed,
            vec![Inbound::Init {
                conversation_id: Some("__CONV__".into())
            }]
        );
    }

    #[test]
    fn parses_turn_text() {
        let fixture = include_str!("../tests/fixtures/turn_text.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 5);
        let Inbound::Step(first) = &parsed[0] else {
            panic!("first frame must be a step");
        };
        assert_eq!(first.step_type, StepType::UserInput);
        assert_eq!(first.state, StepState::Done);
        let Inbound::Step(active) = &parsed[1] else {
            panic!("second frame must be a step");
        };
        assert_eq!(active.step_type, StepType::AgentResponse);
        assert_eq!(active.state, StepState::Active);
        assert_eq!(active.text_delta.as_deref(), Some("Hello"));
        let Inbound::Step(done) = &parsed[3] else {
            panic!("fourth frame must be a step");
        };
        assert_eq!(done.state, StepState::Done);
        assert_eq!(done.text_delta.as_deref(), Some("ld!"));
        let usage = done.usage.expect("DONE agent_response carries usage");
        assert_eq!(usage.input_tokens, 7541);
        assert_eq!(usage.output_tokens, 11);
        assert_eq!(usage.thinking_tokens, 10);
        assert_eq!(usage.total_tokens, 7552);
        let Inbound::Result(result) = &parsed[4] else {
            panic!("last frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Success);
        assert_eq!(result.response.as_deref(), Some("Hello world!"));
        assert_eq!(result.denied_actions.len(), 0);
    }

    #[test]
    fn parses_turn_done_delta() {
        let fixture = include_str!("../tests/fixtures/turn_done_delta.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 5);
        let deltas: Vec<&str> = parsed
            .iter()
            .filter_map(|i| match i {
                Inbound::Step(s) if s.step_type == StepType::AgentResponse => {
                    s.text_delta.as_deref()
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            deltas,
            vec!["The quick brown ", "fox jumps ", "over the lazy dog."]
        );
        let Inbound::Result(result) = &parsed[4] else {
            panic!("last frame must be a result");
        };
        assert_eq!(
            result.response.as_deref(),
            Some("The quick brown fox jumps over the lazy dog.")
        );
    }

    #[test]
    fn parses_path_only_file_tool_steps() {
        let fixture = include_str!("../tests/fixtures/turn_file_tools.jsonl");
        let steps: Vec<Step> = lines(fixture)
            .into_iter()
            .filter_map(parse_line)
            .filter_map(|frame| match frame {
                Inbound::Step(step) if step.step_type == StepType::Tool => Some(step),
                _ => None,
            })
            .collect();
        let names: Vec<&str> = steps
            .iter()
            .filter(|s| s.state == StepState::Done)
            .filter_map(|s| s.tool_name.as_deref())
            .collect();
        assert_eq!(
            names,
            ["write_file", "edit_file", "read_file", "call_mcp_tool"]
        );
        let info = steps[0].tool_info.as_ref().expect("tool_info");
        assert_eq!(info.parameters["Path"], "/tmp/x/hello.txt");
        assert!(info.output.is_none(), "write_file carries no content");
        let mcp = steps[6].tool_info.as_ref().expect("mcp tool_info");
        assert_eq!(mcp.parameters["ServerName"], "playwright");
        assert_eq!(mcp.parameters["ToolName"], "browser_navigate");
    }

    #[test]
    fn parses_turn_tool() {
        let fixture = include_str!("../tests/fixtures/turn_tool.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 7);
        let Inbound::Step(active) = &parsed[2] else {
            panic!("third frame must be a tool step");
        };
        assert_eq!(active.step_type, StepType::Tool);
        assert_eq!(active.state, StepState::Active);
        assert_eq!(active.step_index, 2);
        assert_eq!(active.tool_name.as_deref(), Some("run_command"));
        let info = active.tool_info.as_ref().expect("tool_info present");
        assert_eq!(info.parameters["CommandLine"], "echo hi");
        assert!(info.output.is_none());
        assert!(info.error.is_none());
        let Inbound::Step(done) = &parsed[3] else {
            panic!("fourth frame must be a tool step");
        };
        assert_eq!(done.state, StepState::Done);
        assert_eq!(
            done.tool_info
                .as_ref()
                .and_then(|i| i.output.as_ref())
                .and_then(Value::as_str),
            Some("Command exited with code 0.\n\nCommand output:\nhi\n")
        );
        let Inbound::Result(result) = &parsed[6] else {
            panic!("last frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Success);
    }

    #[test]
    fn parses_turn_tool_error() {
        let fixture = include_str!("../tests/fixtures/turn_tool_error.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 4);
        let Inbound::Step(errored) = &parsed[2] else {
            panic!("third frame must be a tool step");
        };
        assert_eq!(errored.state, StepState::Error);
        let error = errored
            .tool_info
            .as_ref()
            .and_then(|i| i.error.as_ref())
            .expect("tool error is kept raw");
        assert_eq!(error_text(error), "user denied permission to run command");
        let Inbound::Result(result) = &parsed[3] else {
            panic!("last frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Success);
        assert_eq!(result.response.as_deref(), Some(""));
        assert_eq!(result.denied_actions.len(), 1);
        assert_eq!(result.denied_actions[0]["display_name"], "RunCommand");
    }

    #[test]
    fn parses_turn_interrupted() {
        let fixture = include_str!("../tests/fixtures/turn_interrupted.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 2);
        let Inbound::Result(result) = &parsed[1] else {
            panic!("last frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error.as_deref(), Some("interrupted"));
        assert_eq!(
            result.response.as_deref(),
            Some("Rivers are the lifeblood of our planet, winding ")
        );
        assert_eq!(result.usage.expect("usage present").total_tokens, 8509);
    }

    #[test]
    fn parses_turn_cumulative_usage() {
        let fixture = include_str!("../tests/fixtures/turn_cumulative_usage.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 5);
        let Inbound::Step(system) = &parsed[1] else {
            panic!("second frame must be the system_message step");
        };
        assert_eq!(system.step_type, StepType::SystemMessage);
        assert_eq!(system.step_index, 3);
        let Inbound::Step(done) = &parsed[3] else {
            panic!("fourth frame must be the DONE agent_response");
        };
        let step_usage = done.usage.expect("step usage");
        assert_eq!(step_usage.input_tokens, 7762);
        assert_eq!(step_usage.total_tokens, 7784);
        let Inbound::Result(result) = &parsed[4] else {
            panic!("last frame must be a result");
        };
        let result_usage = result.usage.expect("result usage");
        assert_eq!(result_usage.input_tokens, 15303);
        assert_eq!(result_usage.total_tokens, 15336);
    }

    #[test]
    fn parses_turn_error() {
        let fixture = include_str!("../tests/fixtures/turn_error.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 1);
        let Inbound::Result(result) = &parsed[0] else {
            panic!("the only frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error.as_deref(), Some("model overloaded"));
    }

    #[test]
    fn parses_turn_open_tool_then_error() {
        let fixture = include_str!("../tests/fixtures/turn_open_tool_then_error.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 2);
        let Inbound::Step(tool) = &parsed[0] else {
            panic!("first frame must be a tool step");
        };
        assert_eq!(tool.state, StepState::Active);
        assert_eq!(tool.tool_name.as_deref(), Some("view_file"));
        assert_eq!(
            tool.tool_info.as_ref().expect("tool_info").parameters["AbsolutePath"],
            "/tmp/a.rs"
        );
        let Inbound::Result(result) = &parsed[1] else {
            panic!("last frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error.as_deref(), Some("boom"));
    }

    #[test]
    fn parses_stray_cancel_result() {
        let fixture = include_str!("../tests/fixtures/stray_cancel_result.jsonl");
        let parsed: Vec<Inbound> = lines(fixture).into_iter().filter_map(parse_line).collect();
        assert_eq!(parsed.len(), 1);
        let Inbound::Result(result) = &parsed[0] else {
            panic!("the only frame must be a result");
        };
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(
            result.error.as_deref(),
            Some("stream input cancelled: context canceled")
        );
    }

    /// The unknown-conversation fixture is agy STDERR, not stdout: the parser
    /// must not invent a frame for it.
    #[test]
    fn parses_stderr_unknown_conversation() {
        let fixture = include_str!("../tests/fixtures/stderr_unknown_conversation.txt");
        assert!(parse_line(fixture.trim()).is_none());
        assert!(fixture.contains("not found"));
    }

    #[test]
    fn unknown_step_type_and_garbage_tolerated() {
        let line = r#"{"event":"step_update","step_update":{"step_index":7,"state":"FUTURE","step_type":"hologram","text_delta":"x"}}"#;
        let Some(Inbound::Step(step)) = parse_line(line) else {
            panic!("a future step_type must still parse");
        };
        assert_eq!(step.step_type, StepType::Unknown);
        assert_eq!(step.state, StepState::Unknown);
        assert_eq!(step.step_index, 7);

        let line = r#"{"event":"brand_new_event","payload":{"x":1}}"#;
        assert_eq!(parse_line(line), Some(Inbound::Other));

        assert!(parse_line("not json {{").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("42").is_none());
        assert!(parse_line(r#"{"hello":"world"}"#).is_none());
        // Unknown fields are ignored, never rejected.
        let line = r#"{"event":"result","result":{"status":"SUCCESS","response":"ok","future_field":{"deep":[1,2]}},"unknown_top":true}"#;
        let Some(Inbound::Result(result)) = parse_line(line) else {
            panic!("unknown fields must not reject a result");
        };
        assert_eq!(result.response.as_deref(), Some("ok"));
    }

    #[test]
    fn error_text_accepts_string_and_object() {
        assert_eq!(error_text(&Value::String("denied".into())), "denied");
        assert_eq!(
            error_text(&serde_json::json!({"type":"TOOL_ERROR","message":"nope"})),
            "nope"
        );
        assert_eq!(
            error_text(&serde_json::json!({"type":"TOOL_ERROR"})),
            r#"{"type":"TOOL_ERROR"}"#
        );
        assert_eq!(error_text(&Value::Null), "");
    }

    #[test]
    fn user_event_roundtrips() {
        let raw = user_event("a\"b\nc");
        assert!(!raw.contains('\n'), "must be exactly one JSON line");
        let value: Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(value["event"], "user");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"][0]["type"], "text");
        assert_eq!(value["message"]["content"][0]["text"], "a\"b\nc");
    }
}
