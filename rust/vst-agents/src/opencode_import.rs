//! At-rest opencode native-store adapter (ports `agent-plugins/opencodeImport.ts`).
//! Reads opencode's own global SQLite DB **read-only** and normalizes its turns
//! into `NormalizedEvent`s. Uses `rusqlite`, not a hand-rolled parser.

use serde_json::{Map, Value};
use vst_types::{
    NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult, UsageInfo,
};

use crate::native_history_importer::{
    NativeHistoryImporter, NativeImportRequest, NativeImportResult,
};
use crate::util::{ms_to_iso_8601, new_uuid_v4, now_iso_8601};

fn num(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

fn build_usage(tokens: &Map<String, Value>, model: &str) -> UsageInfo {
    let cache = tokens
        .get("cache")
        .and_then(|c| c.as_object())
        .cloned()
        .unwrap_or_default();
    let input_tokens = num(tokens.get("input"));
    let output_tokens = num(tokens.get("output"));
    let cache_read_tokens = num(cache.get("read"));
    let cache_create_tokens = num(cache.get("write"));
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
        provider: NormalizedEventProvider::Opencode,
        kind,
        turn_id: current_turn_id.clone(),
        ..Default::default()
    };
    apply_extra(&mut ev, &extra);
    ev
}

/// Import opencode history from an open (read-only) SQLite connection.
/// Returns (events, nextWatermark).
pub fn import_opencode_history(
    db: &rusqlite::Connection,
    session_id: &str,
    agent_chat_id: &str,
    watermark: Option<&str>,
) -> (Vec<NormalizedEvent>, String) {
    let since: i64 = match watermark {
        Some(w) if !w.is_empty() => w.parse::<i64>().unwrap_or(-1),
        _ => -1,
    };

    let mut events: Vec<NormalizedEvent> = Vec::new();
    let mut current_turn_id: Option<String> = None;
    let mut max_t: i64 = since;
    let mut processed_any = false;

    let mut msg_stmt = db
        .prepare(
            "SELECT id, data, time_created AS t FROM message WHERE session_id = ?1 AND time_created > ?2 ORDER BY time_created ASC, id ASC",
        )
        .unwrap();
    let mut part_stmt = db
        .prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created ASC, id ASC")
        .unwrap();

    let messages: Vec<(String, String, i64)> = {
        let rows = msg_stmt
            .query_map(rusqlite::params![agent_chat_id, since], |r| {
                let id: String = r.get(0)?;
                let data: String = r.get(1)?;
                let t: i64 = r.get(2)?;
                Ok((id, data, t))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    };

    for (msg_id, data, t) in messages {
        processed_any = true;
        if t > max_t {
            max_t = t;
        }
        let md: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let md = match md {
            Value::Object(o) => o,
            _ => continue,
        };
        let role = md
            .get("role")
            .and_then(|r| r.as_str())
            .map(|s| s.to_string());
        let created = md
            .get("time")
            .and_then(|tm| tm.get("created"))
            .and_then(|c| c.as_i64());
        let ts = match created {
            Some(ms) => ms_to_iso_8601(ms),
            None => now_iso_8601(),
        };

        let parts: Vec<Map<String, Value>> = {
            let rows = part_stmt
                .query_map(rusqlite::params![msg_id], |r| {
                    let data: String = r.get(0)?;
                    Ok(data)
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<String>>>()
                .unwrap();
            rows.into_iter()
                .filter_map(|d| serde_json::from_str::<Value>(&d).ok())
                .filter_map(|v| match v {
                    Value::Object(o) => Some(o),
                    _ => None,
                })
                .collect()
        };

        match role.as_deref() {
            Some("user") => {
                current_turn_id = Some(msg_id.clone());
                let texts: Vec<String> = parts
                    .iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|p| {
                        p.get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect();
                let mut extra = Map::new();
                extra.insert("role".into(), serde_json::json!("user"));
                extra.insert("text".into(), Value::String(texts.join("\n")));
                events.push(mk_event(
                    session_id,
                    &ts,
                    &current_turn_id,
                    NormalizedEventKind::User,
                    extra,
                ));
            }
            Some("assistant") => {
                for p in &parts {
                    let part_type = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match part_type {
                        "text" => {
                            if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
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
                        "reasoning" => {
                            if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
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
                        "tool" => {
                            let st = p
                                .get("state")
                                .and_then(|s| s.as_object())
                                .cloned()
                                .unwrap_or_default();
                            let status = st
                                .get("status")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string());
                            let call_id = p
                                .get("callID")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string());
                            let tool_name = p
                                .get("tool")
                                .and_then(|t| t.as_str())
                                .map(|s| s.to_string());
                            let mut extra = Map::new();
                            extra.insert("role".into(), serde_json::json!("assistant"));
                            if let Some(name) = &tool_name {
                                extra.insert("tool_name".into(), Value::String(name.clone()));
                            }
                            if let Some(id) = &call_id {
                                extra.insert("tool_id".into(), Value::String(id.clone()));
                            }
                            extra.insert(
                                "tool_input".into(),
                                st.get("input").cloned().unwrap_or(Value::Null),
                            );
                            events.push(mk_event(
                                session_id,
                                &ts,
                                &current_turn_id,
                                NormalizedEventKind::ToolUse,
                                extra,
                            ));

                            if status.as_deref() == Some("completed")
                                || status.as_deref() == Some("error")
                            {
                                let raw = st
                                    .get("output")
                                    .cloned()
                                    .or_else(|| st.get("error").cloned());
                                let content_str = match &raw {
                                    Some(Value::String(s)) => Some(s.clone()),
                                    Some(Value::Null) | None => None,
                                    Some(other) => serde_json::to_string(other).ok(),
                                };
                                let mut extra2 = Map::new();
                                if let Some(id) = &call_id {
                                    extra2.insert("tool_id".into(), Value::String(id.clone()));
                                }
                                let is_error = status.as_deref() == Some("error");
                                extra2.insert(
                                    "tool_result".into(),
                                    serde_json::json!({ "content": content_str.clone(), "is_error": is_error }),
                                );
                                events.push(mk_event(
                                    session_id,
                                    &ts,
                                    &current_turn_id,
                                    NormalizedEventKind::ToolResult,
                                    extra2,
                                ));
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(Value::Object(tokens)) = md.get("tokens") {
                    let model = md
                        .get("modelID")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let usage = build_usage(tokens, &model);
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
            _ => {}
        }
    }

    let next_watermark = if !processed_any {
        watermark.unwrap_or("").to_string()
    } else {
        max_t.to_string()
    };
    (events, next_watermark)
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
            _ => {}
        }
    }
}

/// `~/.local/share/opencode/opencode.db`
pub fn opencode_native_store_path() -> String {
    crate::home::home_dir()
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db")
        .display()
        .to_string()
}

/// An opencode importer built from a test seam (injected db path).
pub struct OpencodeHistoryImporter {
    db_path: String,
}

impl NativeHistoryImporter for OpencodeHistoryImporter {
    fn cli(&self) -> &'static str {
        "opencode"
    }

    fn import(&self, req: &NativeImportRequest) -> NativeImportResult {
        if !std::path::Path::new(&self.db_path).exists() {
            return NativeImportResult {
                events: Vec::new(),
                next_watermark: req.watermark.clone().unwrap_or_default(),
            };
        }
        let conn = rusqlite::Connection::open_with_flags(
            &self.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok();
        let conn = match conn {
            Some(c) => c,
            None => {
                return NativeImportResult {
                    events: Vec::new(),
                    next_watermark: req.watermark.clone().unwrap_or_default(),
                };
            }
        };
        let (events, next_watermark) = import_opencode_history(
            &conn,
            &req.session_id,
            &req.agent_chat_id,
            req.watermark.as_deref(),
        );
        let next_watermark = if next_watermark.is_empty() {
            req.watermark.clone().unwrap_or_default()
        } else {
            next_watermark
        };
        NativeImportResult {
            events,
            next_watermark,
        }
    }
}

/// Create an opencode importer (None → default `~/.local/share/opencode/opencode.db`).
pub fn create_opencode_history_importer(db_path: Option<String>) -> OpencodeHistoryImporter {
    OpencodeHistoryImporter {
        db_path: db_path.unwrap_or_else(opencode_native_store_path),
    }
}

/// The shared default opencode importer.
pub fn opencode_history_importer() -> &'static dyn NativeHistoryImporter {
    static IMPORTER: std::sync::OnceLock<OpencodeHistoryImporter> = std::sync::OnceLock::new();
    IMPORTER.get_or_init(|| create_opencode_history_importer(None))
}
