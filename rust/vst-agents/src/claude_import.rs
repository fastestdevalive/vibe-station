//! At-rest Claude native-store adapter (ports `agent-plugins/claudeImport.ts`).
//! Reads a claude `.jsonl` project transcript and normalizes its turns into
//! `NormalizedEvent`s. Pure, self-contained — no shared state.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value};
use vst_types::{
    NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolDiff, ToolResult,
    UsageInfo,
};

use crate::native_history_importer::{
    NativeHistoryImporter, NativeImportRequest, NativeImportResult,
};
use crate::util::{new_uuid_v4, now_iso_8601};

const SKIP_TYPES: &[&str] = &[
    "system",
    "mode",
    "file-history-snapshot",
    "ai-title",
    "last-prompt",
    "queue-operation",
    "attachment",
];
const DIFF_TOOL_NAMES: &[&str] = &["Edit", "MultiEdit"];
const BASE64_PLACEHOLDER: &str = "[base64 <media> stripped: <N> chars]";

/// Recursively replace inline base64 image sources with a placeholder
/// (claude-native only). Short-circuits recursion on a match.
pub fn strip_inline_base64(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(strip_inline_base64).collect()),
        Value::Object(mut obj) => {
            if let Some(source) = obj.get("source") {
                if let Value::Object(src) = source {
                    let is_base64 = src.get("type").and_then(|t| t.as_str()) == Some("base64");
                    let data_is_string = matches!(src.get("data"), Some(Value::String(_)));
                    if is_base64 && data_is_string {
                        let media = src
                            .get("media_type")
                            .and_then(|m| m.as_str())
                            .unwrap_or("application/octet-stream");
                        let data_len = src
                            .get("data")
                            .and_then(|d| d.as_str())
                            .map(|s| s.chars().count())
                            .unwrap_or(0);
                        let placeholder = BASE64_PLACEHOLDER
                            .replace("<media>", media)
                            .replace("<N>", &data_len.to_string());
                        if let Some(Value::Object(ref mut src_obj)) = obj.get_mut("source") {
                            src_obj.insert("data".to_string(), Value::String(placeholder));
                        }
                        return Value::Object(obj);
                    }
                }
            }
            let mut out = Map::new();
            for (k, v) in obj.into_iter() {
                out.insert(k, strip_inline_base64(v));
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn num(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

fn build_usage(usage_raw: &Map<String, Value>, model: &str) -> UsageInfo {
    let input_tokens = num(usage_raw.get("input_tokens"));
    let output_tokens = num(usage_raw.get("output_tokens"));
    let cache_read_tokens = num(usage_raw.get("cache_read_input_tokens"));
    let cache_create_tokens = num(usage_raw.get("cache_creation_input_tokens"));
    UsageInfo {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_create_tokens,
        total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_create_tokens,
        context_window: None,
        cost_usd: None,
        model: model.to_string(),
    }
}

/// Parse a claude `.jsonl` native history. Returns (events, nextLine).
pub fn parse_claude_native_history(
    lines: &[String],
    session_id: &str,
    start_line: usize,
) -> (Vec<NormalizedEvent>, usize) {
    let mut events: Vec<NormalizedEvent> = Vec::new();
    let mut current_turn_id: Option<String> = None;
    let mut edit_tool_call_by_id: HashMap<String, (String, Map<String, Value>)> = HashMap::new();

    for (i, raw) in lines.iter().enumerate() {
        if i < start_line {
            continue;
        }
        if raw.is_empty() || raw.trim().is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let d = match parsed {
            Value::Object(o) => o,
            _ => continue,
        };
        let ty = match d.get("type").and_then(|t| t.as_str()) {
            Some(t) => t.to_string(),
            None => continue,
        };
        if SKIP_TYPES.contains(&ty.as_str()) {
            continue;
        }
        if ty != "user" && ty != "assistant" {
            continue;
        }
        if d.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
            || d.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
        {
            continue;
        }
        let ts = d
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(now_iso_8601);
        let msg = match d.get("message") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let content = msg.get("content").cloned();

        if ty == "user" {
            // Harness-injected gate BEFORE branching.
            let origin_kind = d.get("origin").and_then(|o| o.get("kind")).cloned();
            let harness_injected = d.get("promptSource").and_then(|p| p.as_str()) == Some("system")
                || (origin_kind.is_some()
                    && origin_kind.as_ref().and_then(|o| o.as_str()) != Some("human"));

            match content {
                Some(Value::String(s)) => {
                    if harness_injected {
                        continue;
                    }
                    current_turn_id = d
                        .get("uuid")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| Some(new_uuid_v4()));
                    let mut extra = Map::new();
                    extra.insert("role".into(), serde_json::json!("user"));
                    extra.insert("text".into(), Value::String(s));
                    events.push(mk_event(
                        session_id,
                        &ts,
                        &current_turn_id,
                        NormalizedEventKind::User,
                        extra,
                    ));
                }
                Some(Value::Array(blocks)) => {
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_results: Vec<Value> = Vec::new();
                    for block in &blocks {
                        if let Value::Object(b) = block {
                            match b.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                        text_parts.push(t.to_string());
                                    }
                                }
                                Some("tool_result") => tool_results.push(block.clone()),
                                _ => {}
                            }
                        }
                    }
                    if !text_parts.is_empty() && !harness_injected {
                        current_turn_id = d
                            .get("uuid")
                            .and_then(|u| u.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| Some(new_uuid_v4()));
                        let mut extra = Map::new();
                        extra.insert("role".into(), serde_json::json!("user"));
                        extra.insert(
                            "text".into(),
                            Value::String(text_parts.last().unwrap().clone()),
                        );
                        events.push(mk_event(
                            session_id,
                            &ts,
                            &current_turn_id,
                            NormalizedEventKind::User,
                            extra,
                        ));
                    }
                    for block in tool_results {
                        let b = match block {
                            Value::Object(b) => b,
                            _ => continue,
                        };
                        let stripped =
                            strip_inline_base64(b.get("content").cloned().unwrap_or(Value::Null));
                        let content_str = match &stripped {
                            Value::String(s) => Some(s.clone()),
                            Value::Null => None,
                            other => serde_json::to_string(other).ok(),
                        };
                        let tool_id = b
                            .get("tool_use_id")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string());
                        let mut tool_diffs: Option<Vec<ToolDiff>> = None;
                        if let Some(id) = &tool_id {
                            if let Some((name, input)) = edit_tool_call_by_id.remove(id) {
                                if name == "Edit"
                                    && input.get("old_string").and_then(|v| v.as_str()).is_some()
                                    && input.get("new_string").and_then(|v| v.as_str()).is_some()
                                {
                                    let old_string = input
                                        .get("old_string")
                                        .and_then(|v| v.as_str())
                                        .unwrap()
                                        .to_string();
                                    let new_string = input
                                        .get("new_string")
                                        .and_then(|v| v.as_str())
                                        .unwrap()
                                        .to_string();
                                    let path = input
                                        .get("file_path")
                                        .and_then(|p| p.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    tool_diffs = Some(vec![ToolDiff {
                                        path,
                                        old_text: Some(old_string),
                                        new_text: new_string,
                                    }]);
                                } else if name == "MultiEdit" {
                                    let mut diffs: Vec<ToolDiff> = Vec::new();
                                    if let Some(Value::Array(edits)) = input.get("edits") {
                                        for e in edits {
                                            if let Value::Object(e) = e {
                                                if e.get("old_string")
                                                    .and_then(|v| v.as_str())
                                                    .is_some()
                                                    && e.get("new_string")
                                                        .and_then(|v| v.as_str())
                                                        .is_some()
                                                {
                                                    let old_string = e
                                                        .get("old_string")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap()
                                                        .to_string();
                                                    let new_string = e
                                                        .get("new_string")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap()
                                                        .to_string();
                                                    let path = e
                                                        .get("file_path")
                                                        .and_then(|p| p.as_str())
                                                        .or_else(|| {
                                                            input
                                                                .get("file_path")
                                                                .and_then(|p| p.as_str())
                                                        })
                                                        .unwrap_or("")
                                                        .to_string();
                                                    diffs.push(ToolDiff {
                                                        path,
                                                        old_text: Some(old_string),
                                                        new_text: new_string,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    if !diffs.is_empty() {
                                        tool_diffs = Some(diffs);
                                    }
                                }
                            }
                        }
                        let mut extra = Map::new();
                        if let Some(id) = &tool_id {
                            extra.insert("tool_id".into(), Value::String(id.clone()));
                        }
                        let is_error = b.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                        let mut extra = Map::new();
                        if let Some(id) = &tool_id {
                            extra.insert("tool_id".into(), Value::String(id.clone()));
                        }
                        extra.insert("tool_result".into(), serde_json::json!({ "content": content_str.clone(), "is_error": is_error }));
                        if let Some(diffs) = tool_diffs {
                            extra.insert(
                                "tool_diffs".into(),
                                serde_json::to_value(diffs).unwrap_or(Value::Null),
                            );
                        }
                        events.push(mk_event(
                            session_id,
                            &ts,
                            &current_turn_id,
                            NormalizedEventKind::ToolResult,
                            extra,
                        ));
                    }
                }
                _ => {}
            }
        } else {
            // assistant
            if let Some(Value::Array(blocks)) = content {
                for block in &blocks {
                    let b = match block {
                        Value::Object(b) => b,
                        _ => continue,
                    };
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                let mut extra = Map::new();
                                extra.insert("role".into(), serde_json::json!("assistant"));
                                extra.insert("text".into(), Value::String(t.to_string()));
                                events.push(mk_event(
                                    session_id,
                                    &ts,
                                    &current_turn_id,
                                    NormalizedEventKind::Text,
                                    extra,
                                ));
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                                let mut extra = Map::new();
                                extra.insert("role".into(), serde_json::json!("assistant"));
                                extra.insert("text".into(), Value::String(t.to_string()));
                                events.push(mk_event(
                                    session_id,
                                    &ts,
                                    &current_turn_id,
                                    NormalizedEventKind::Thinking,
                                    extra,
                                ));
                            }
                        }
                        Some("tool_use") => {
                            let tool_id =
                                b.get("id").and_then(|t| t.as_str()).map(|s| s.to_string());
                            let tool_input =
                                strip_inline_base64(b.get("input").cloned().unwrap_or(Value::Null));
                            let tool_name = b
                                .get("name")
                                .and_then(|t| t.as_str())
                                .map(|s| s.to_string());
                            if let (Some(id), Some(name)) = (&tool_id, &tool_name) {
                                if DIFF_TOOL_NAMES.contains(&name.as_str()) {
                                    if let Value::Object(input) = &tool_input {
                                        edit_tool_call_by_id
                                            .insert(id.clone(), (name.clone(), input.clone()));
                                    }
                                }
                            }
                            let mut extra = Map::new();
                            extra.insert("role".into(), serde_json::json!("assistant"));
                            if let Some(name) = &tool_name {
                                extra.insert("tool_name".into(), Value::String(name.clone()));
                            }
                            if let Some(id) = &tool_id {
                                extra.insert("tool_id".into(), Value::String(id.clone()));
                            }
                            extra.insert("tool_input".into(), tool_input);
                            events.push(mk_event(
                                session_id,
                                &ts,
                                &current_turn_id,
                                NormalizedEventKind::ToolUse,
                                extra,
                            ));
                        }
                        _ => {}
                    }
                }
            }
            if let Some(Value::Object(usage_raw)) = msg.get("usage") {
                let model = msg
                    .get("model")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                let usage = build_usage(usage_raw, &model);
                if usage.total_tokens > 0 {
                    let mut extra = Map::new();
                    extra.insert(
                        "usage".into(),
                        serde_json::to_value(&usage).unwrap_or(Value::Null),
                    );
                    if !model.is_empty() {
                        extra.insert("model".into(), Value::String(model.clone()));
                    }
                    events.push(mk_event(
                        session_id,
                        &ts,
                        &current_turn_id,
                        NormalizedEventKind::Usage,
                        extra,
                    ));
                }
            }
        }
    }

    (events, lines.len())
}

fn mk_event(
    session_id: &str,
    ts: &str,
    current_turn_id: &Option<String>,
    kind: NormalizedEventKind,
    extra: Map<String, Value>,
) -> NormalizedEvent {
    let mut ev = NormalizedEvent {
        id: new_uuid_v4(),
        session_id: session_id.to_string(),
        ts: ts.to_string(),
        provider: NormalizedEventProvider::Claude,
        kind,
        turn_id: current_turn_id.clone(),
        ..Default::default()
    };
    apply_extra(&mut ev, &extra);
    ev
}

fn apply_extra(ev: &mut NormalizedEvent, extra: &Map<String, Value>) {
    for (k, v) in extra {
        match k.as_str() {
            "role" => {
                ev.role = v.as_str().map(|r| {
                    if r == "assistant" {
                        Role::Assistant
                    } else {
                        Role::User
                    }
                })
            }
            "text" => ev.text = v.as_str().map(|s| s.to_string()),
            "tool_name" => ev.tool_name = v.as_str().map(|s| s.to_string()),
            "tool_id" => ev.tool_id = v.as_str().map(|s| s.to_string()),
            "tool_input" => ev.tool_input = Some(v.clone()),
            "tool_result" => {
                let content = v
                    .get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                let is_error = v.get("is_error").and_then(|e| e.as_bool());
                ev.tool_result = Some(ToolResult { content, is_error });
            }
            "usage" => ev.usage = serde_json::from_value(v.clone()).ok(),
            "model" => ev.model = v.as_str().map(|s| s.to_string()),
            "tool_diffs" => ev.tool_diffs = serde_json::from_value(v.clone()).ok(),
            _ => {}
        }
    }
}

/// `~/.claude/projects/<slug>/<chatId>.jsonl` where slug = cwd with `/` and
/// `.` replaced by `-` (in that order).
pub fn claude_native_store_path(projects_dir: &str, cwd: &str, agent_chat_id: &str) -> String {
    let slug = cwd.replace(['/', '.'], "-");
    format!("{projects_dir}/{slug}/{agent_chat_id}.jsonl")
}

fn read_native_lines(file: &str) -> Vec<String> {
    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    if lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines
}

/// A claude importer built from a test seam (injected projects dir).
pub struct ClaudeHistoryImporter {
    projects_dir: String,
}

impl NativeHistoryImporter for ClaudeHistoryImporter {
    fn cli(&self) -> &'static str {
        "claude"
    }

    fn import(&self, req: &NativeImportRequest) -> NativeImportResult {
        let file = claude_native_store_path(&self.projects_dir, &req.cwd, &req.agent_chat_id);
        let start_line = match &req.watermark {
            Some(w) => w.parse::<usize>().unwrap_or(0),
            None => 0,
        };
        if !Path::new(&file).exists() {
            return NativeImportResult {
                events: Vec::new(),
                next_watermark: req.watermark.clone().unwrap_or_else(|| "0".to_string()),
            };
        }
        let lines = read_native_lines(&file);
        let (events, next_line) = parse_claude_native_history(&lines, &req.session_id, start_line);
        NativeImportResult {
            events,
            next_watermark: next_line.to_string(),
        }
    }
}

/// Create a claude importer (None → default `~/.claude/projects`).
pub fn create_claude_history_importer(projects_dir: Option<String>) -> ClaudeHistoryImporter {
    let dir = projects_dir.unwrap_or_else(|| {
        crate::home::home_dir()
            .join(".claude")
            .join("projects")
            .display()
            .to_string()
    });
    ClaudeHistoryImporter { projects_dir: dir }
}

/// The shared default claude importer.
pub fn claude_history_importer() -> &'static dyn NativeHistoryImporter {
    static IMPORTER: std::sync::OnceLock<ClaudeHistoryImporter> = std::sync::OnceLock::new();
    IMPORTER.get_or_init(|| create_claude_history_importer(None))
}
