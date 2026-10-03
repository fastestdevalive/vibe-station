//! At-rest codex native-store adapter.
//! Reads a codex rollout `.jsonl` (one thread per file) read-only and
//! normalizes its COMPLETED turns into `NormalizedEvent`s.
//!
//! Source of truth = `event_msg` lines whose `payload.type` is
//! `item_completed` and whose `item.type` ∈ {`UserMessage`, `AgentMessage`,
//! `CommandExecution`}; `token_count` lines (with non-null `info`) produce
//! `Usage` events. A turn is only emitted once its `task_complete` /
//! `turn_aborted` line is seen (the store dedups per `turn_id`, so a partial
//! turn would lose its tail). The returned watermark is the `ordinal` of the
//! last emitted turn's end line.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use vst_types::{
    AcpToolKind, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult,
    UsageInfo,
};

use crate::native_chat_id::extract_codex_thread_id;
use crate::native_history_importer::{
    NativeHistoryImporter, NativeImportRequest, NativeImportResult,
};
use crate::util::{new_uuid_v4, now_iso_8601};

fn num(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

/// A line's `ordinal`, or its 1-based line index when the field is absent.
fn line_ordinal(d: &Map<String, Value>, idx: usize) -> i64 {
    d.get("ordinal")
        .and_then(|o| o.as_i64())
        .unwrap_or((idx + 1) as i64)
}

fn mk_event(
    session_id: &str,
    ts: &str,
    turn_id: &Option<String>,
    kind: NormalizedEventKind,
    extra: Map<String, Value>,
) -> NormalizedEvent {
    let mut ev = NormalizedEvent {
        id: new_uuid_v4(),
        session_id: session_id.to_string(),
        ts: ts.to_string(),
        provider: NormalizedEventProvider::Codex,
        kind,
        turn_id: turn_id.clone(),
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
            _ => {}
        }
    }
}

/// Build a `UsageInfo` from a codex `last_token_usage` object.
/// `input_tokens` INCLUDES `cached_input_tokens`, so the normalized input is
/// the delta.
fn build_usage(last: &Map<String, Value>, context_window: i64, model: &str) -> UsageInfo {
    let input_tokens = num(last.get("input_tokens"));
    let cached = num(last.get("cached_input_tokens"));
    let cache_write = num(last.get("cache_write_input_tokens"));
    let output_tokens = num(last.get("output_tokens"));
    let total_tokens = num(last.get("total_tokens"));
    UsageInfo {
        input_tokens: input_tokens - cached,
        output_tokens,
        cache_read_tokens: cached,
        cache_create_tokens: cache_write,
        total_tokens,
        context_window: Some(context_window),
        cost_usd: None,
        model: model.to_string(),
    }
}

/// Import codex history from a rollout `.jsonl` file.
/// Returns `(events, next_watermark)`.
///
/// A missing/unreadable file yields empty events and echoes the input
/// watermark unchanged; when nothing is emitted the input watermark is echoed.
pub fn import_codex_history(
    path: &std::path::Path,
    session_id: &str,
    watermark: Option<&str>,
) -> (Vec<NormalizedEvent>, String) {
    let since: i64 = match watermark {
        Some(w) if !w.is_empty() => w.parse::<i64>().unwrap_or(-1),
        _ => -1,
    };
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (Vec::new(), watermark.unwrap_or("").to_string()),
    };

    let mut events: Vec<NormalizedEvent> = Vec::new();
    let mut buffered: Vec<NormalizedEvent> = Vec::new();
    let mut current_turn_id: Option<String> = None;
    let mut model: String = String::new();
    let mut last_emitted_ordinal: Option<i64> = None;

    for (idx, raw) in content.lines().enumerate() {
        if raw.trim().is_empty() {
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
        let ordinal = line_ordinal(&d, idx);
        if ordinal <= since {
            continue;
        }
        let ts = d
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(now_iso_8601);
        let ty = d.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = d
            .get("payload")
            .and_then(|p| p.as_object())
            .cloned()
            .unwrap_or_default();

        match ty {
            "turn_context" => {
                if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                    model = m.to_string();
                }
            }
            "event_msg" => {
                let etype = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match etype {
                    "task_started" => {
                        current_turn_id = payload
                            .get("turn_id")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string());
                    }
                    "task_complete" | "turn_aborted" => {
                        events.append(&mut buffered);
                        last_emitted_ordinal = Some(ordinal);
                        current_turn_id = None;
                    }
                    "item_completed" => {
                        let item = payload
                            .get("item")
                            .and_then(|i| i.as_object())
                            .cloned()
                            .unwrap_or_default();
                        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let turn_id = payload
                            .get("turn_id")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| current_turn_id.clone());
                        match item_type {
                            "UserMessage" => {
                                let texts: Vec<String> = item
                                    .get("content")
                                    .and_then(|c| c.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter(|b| {
                                                b.get("type").and_then(|t| t.as_str())
                                                    == Some("text")
                                            })
                                            .filter_map(|b| {
                                                b.get("text")
                                                    .and_then(|t| t.as_str())
                                                    .map(|s| s.to_string())
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let mut extra = Map::new();
                                extra.insert("role".into(), serde_json::json!("user"));
                                extra.insert("text".into(), Value::String(texts.join("\n")));
                                buffered.push(mk_event(
                                    session_id,
                                    &ts,
                                    &turn_id,
                                    NormalizedEventKind::User,
                                    extra,
                                ));
                            }
                            "AgentMessage" => {
                                let texts: Vec<String> = item
                                    .get("content")
                                    .and_then(|c| c.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter(|b| {
                                                b.get("type").and_then(|t| t.as_str())
                                                    == Some("Text")
                                            })
                                            .filter_map(|b| {
                                                b.get("text")
                                                    .and_then(|t| t.as_str())
                                                    .map(|s| s.to_string())
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let mut extra = Map::new();
                                extra.insert("role".into(), serde_json::json!("assistant"));
                                extra.insert("text".into(), Value::String(texts.join("\n")));
                                buffered.push(mk_event(
                                    session_id,
                                    &ts,
                                    &turn_id,
                                    NormalizedEventKind::Text,
                                    extra,
                                ));
                            }
                            "CommandExecution" => {
                                let item_id = item
                                    .get("id")
                                    .and_then(|t| t.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_default();
                                let cwd = item
                                    .get("cwd")
                                    .and_then(|c| c.as_str())
                                    .map(|s| s.trim_start_matches("file://").to_string())
                                    .unwrap_or_default();
                                let parsed_cmd_cmd = item
                                    .get("parsed_cmd")
                                    .and_then(|p| p.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|p0| p0.get("cmd"))
                                    .and_then(|c| c.as_str())
                                    .map(|s| s.to_string());
                                let argv_joined = item
                                    .get("command")
                                    .and_then(|c| c.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|a| a.as_str())
                                            .collect::<Vec<_>>()
                                            .join(" ")
                                    })
                                    .unwrap_or_default();
                                let command = parsed_cmd_cmd.unwrap_or(argv_joined);
                                let status =
                                    item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                                let exit_code = item.get("exit_code");
                                let is_error = status != "completed"
                                    || exit_code
                                        .map(|e| e.as_i64().unwrap_or(1) != 0)
                                        .unwrap_or(true);
                                let aggregated_output = item
                                    .get("aggregated_output")
                                    .and_then(|a| a.as_str())
                                    .map(|s| s.to_string());

                                let mut input = Map::new();
                                input.insert("command".into(), Value::String(command));
                                input.insert("cwd".into(), Value::String(cwd));

                                let mut tool_extra = Map::new();
                                tool_extra.insert("role".into(), serde_json::json!("assistant"));
                                tool_extra
                                    .insert("tool_name".into(), Value::String("shell".into()));
                                tool_extra.insert("tool_id".into(), Value::String(item_id.clone()));
                                tool_extra.insert("tool_input".into(), Value::Object(input));
                                let mut tool_use = mk_event(
                                    session_id,
                                    &ts,
                                    &turn_id,
                                    NormalizedEventKind::ToolUse,
                                    tool_extra,
                                );
                                tool_use.tool_kind = Some(AcpToolKind::Execute);
                                buffered.push(tool_use);

                                let mut result_extra = Map::new();
                                result_extra.insert("tool_id".into(), Value::String(item_id));
                                result_extra.insert(
                                    "tool_result".into(),
                                    serde_json::json!({ "content": aggregated_output, "is_error": is_error }),
                                );
                                buffered.push(mk_event(
                                    session_id,
                                    &ts,
                                    &turn_id,
                                    NormalizedEventKind::ToolResult,
                                    result_extra,
                                ));
                            }
                            _ => {}
                        }
                    }
                    "token_count" => {
                        let info = payload.get("info").and_then(|i| i.as_object()).cloned();
                        if let Some(info) = info {
                            let last = info
                                .get("last_token_usage")
                                .and_then(|l| l.as_object())
                                .cloned()
                                .unwrap_or_default();
                            let context_window = num(info.get("model_context_window"));
                            let usage = build_usage(&last, context_window, &model);
                            if usage.total_tokens > 0 {
                                let mut extra = Map::new();
                                extra.insert(
                                    "usage".into(),
                                    serde_json::to_value(&usage).unwrap_or(Value::Null),
                                );
                                if !model.is_empty() {
                                    extra.insert("model".into(), Value::String(model.clone()));
                                }
                                buffered.push(mk_event(
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
            _ => {}
        }
    }

    let next_watermark = match last_emitted_ordinal {
        Some(o) => o.to_string(),
        None => watermark.unwrap_or("").to_string(),
    };
    (events, next_watermark)
}

/// Codex's home dir: `$CODEX_HOME` when set (codex honours it), else `~/.codex`.
/// The single place both the history importer and the codex plugin's resume
/// check resolve it, so they can never disagree about where rollouts live.
/// An active test home override (`home::with_home`) wins over the env var.
pub(crate) fn codex_home() -> PathBuf {
    codex_home_from(
        std::env::var_os("CODEX_HOME").filter(|_| !crate::home::is_overridden()),
        crate::home::home_dir(),
    )
}

fn codex_home_from(codex_home_env: Option<std::ffi::OsString>, home: PathBuf) -> PathBuf {
    match codex_home_env.filter(|v| !v.is_empty()) {
        Some(h) => PathBuf::from(h),
        None => home.join(".codex"),
    }
}

/// `<codex home>/sessions`
pub fn codex_native_store_path() -> PathBuf {
    codex_home().join("sessions")
}

/// Outcome of a bounded rollout search. `Unsure` = part of the tree could not be
/// read, so absence is not proven.
pub(crate) enum RolloutSearch {
    Found(PathBuf),
    NotFound,
    Unsure,
}

/// `sessions/YYYY/MM/DD/rollout-*.jsonl` is 3 directories deep; one spare level.
const ROLLOUT_MAX_DEPTH: u8 = 4;

/// Search `root` (sync `std::fs`) for the rollout whose thread id is `thread_id`
/// (matched exactly via `extract_codex_thread_id`). Bounded by depth and never
/// follows symlinks (`DirEntry::file_type` doesn't), so a link cycle can't loop.
fn search_rollout(root: &Path, thread_id: &str) -> RolloutSearch {
    let mut unsure = false;
    let mut stack: Vec<(PathBuf, u8)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                unsure = true;
                continue;
            }
        };
        for entry in entries {
            let Ok(entry) = entry else {
                unsure = true;
                continue;
            };
            let Ok(ft) = entry.file_type() else {
                unsure = true;
                continue;
            };
            if ft.is_symlink() {
                // Never followed (cycle safety), but it may hide the rollout.
                unsure = true;
            } else if ft.is_dir() {
                if depth < ROLLOUT_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
            } else if ft.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if extract_codex_thread_id(&name).as_deref() == Some(thread_id) {
                    return RolloutSearch::Found(entry.path());
                }
            }
        }
    }
    if unsure {
        RolloutSearch::Unsure
    } else {
        RolloutSearch::NotFound
    }
}

/// Look for a thread's rollout under `sessions_root` and its sibling
/// `archived_sessions` (where `codex` moves archived threads, still resumable).
pub(crate) fn find_rollout(sessions_root: &Path, thread_id: &str) -> RolloutSearch {
    let archived = sessions_root.with_file_name("archived_sessions");
    let mut unsure = false;
    for root in [sessions_root, archived.as_path()] {
        match search_rollout(root, thread_id) {
            found @ RolloutSearch::Found(_) => return found,
            RolloutSearch::Unsure => unsure = true,
            RolloutSearch::NotFound => {}
        }
    }
    if unsure {
        RolloutSearch::Unsure
    } else {
        RolloutSearch::NotFound
    }
}

fn find_thread_file(store_root: &Path, agent_chat_id: &str) -> Option<PathBuf> {
    match find_rollout(store_root, agent_chat_id) {
        RolloutSearch::Found(p) => Some(p),
        _ => None,
    }
}

/// A codex importer built from a test seam (injected store root).
pub struct CodexHistoryImporter {
    store_root: PathBuf,
}

impl NativeHistoryImporter for CodexHistoryImporter {
    fn cli(&self) -> &'static str {
        "codex"
    }

    fn import(&self, req: &NativeImportRequest) -> NativeImportResult {
        let Some(path) = find_thread_file(&self.store_root, &req.agent_chat_id) else {
            return NativeImportResult {
                events: Vec::new(),
                next_watermark: req.watermark.clone().unwrap_or_default(),
            };
        };
        let (events, next_watermark) =
            import_codex_history(&path, &req.session_id, req.watermark.as_deref());
        NativeImportResult {
            events,
            next_watermark,
        }
    }
}

/// Create a codex importer (None → default `~/.codex/sessions`).
pub fn create_codex_history_importer(store_root: Option<String>) -> CodexHistoryImporter {
    CodexHistoryImporter {
        store_root: PathBuf::from(
            store_root.unwrap_or_else(|| codex_native_store_path().display().to_string()),
        ),
    }
}

/// The shared default codex importer.
pub fn codex_history_importer() -> &'static dyn NativeHistoryImporter {
    static IMPORTER: std::sync::OnceLock<CodexHistoryImporter> = std::sync::OnceLock::new();
    IMPORTER.get_or_init(|| create_codex_history_importer(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/codex/rollout-sample.jsonl"
    );
    const SESSION: &str = "sess-codex-1";
    const TURN1: &str = "01a0fe81-d240-7ac0-817c-e84ac3fc941a";

    #[test]
    fn import_golden_order_and_turn() {
        let (events, wm) = import_codex_history(std::path::Path::new(FIXTURE), SESSION, None);
        let kinds: Vec<_> = events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                NormalizedEventKind::User,
                NormalizedEventKind::ToolUse,
                NormalizedEventKind::ToolResult,
                NormalizedEventKind::Usage,
                NormalizedEventKind::Text,
                NormalizedEventKind::Usage,
            ]
        );
        for e in &events {
            assert_eq!(e.turn_id.as_deref(), Some(TURN1));
            assert_eq!(e.session_id, SESSION);
        }
        assert_eq!(wm, "19");
    }

    #[test]
    fn reimport_with_watermark_emits_nothing() {
        let (events, wm) = import_codex_history(std::path::Path::new(FIXTURE), SESSION, Some("19"));
        assert!(events.is_empty());
        assert_eq!(wm, "19");
    }

    #[test]
    fn tool_result_and_usage_values() {
        let (events, _) = import_codex_history(std::path::Path::new(FIXTURE), SESSION, None);
        let tr = events
            .iter()
            .find(|e| e.kind == NormalizedEventKind::ToolResult)
            .unwrap();
        let tr = tr.tool_result.as_ref().unwrap();
        assert_eq!(tr.content.as_deref(), Some("hi\n"));
        assert_eq!(tr.is_error, Some(false));

        let usages: Vec<_> = events
            .iter()
            .filter(|e| e.kind == NormalizedEventKind::Usage)
            .collect();
        assert_eq!(usages.len(), 2);
        let u1 = usages[0].usage.as_ref().unwrap();
        assert_eq!(u1.input_tokens, 1839);
        assert_eq!(u1.cache_read_tokens, 11008);
        assert_eq!(u1.model, "gpt-6-luna");
    }

    #[test]
    fn malformed_inputs_do_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("garbage.jsonl");
        std::fs::write(
            &p,
            "not json\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"UnknownThing\"}}}\n",
        )
        .unwrap();
        let (events, wm) = import_codex_history(&p, SESSION, Some("not-a-number"));
        assert!(events.is_empty());
        assert_eq!(wm, "not-a-number");
    }

    #[test]
    fn missing_file_echoes_watermark() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.jsonl");
        let (events, wm) = import_codex_history(&missing, SESSION, Some("7"));
        assert!(events.is_empty());
        assert_eq!(wm, "7");
    }
}

#[cfg(test)]
mod codex_home_tests {
    use super::codex_home_from;
    use std::path::PathBuf;

    #[test]
    fn codex_home_env_wins_then_falls_back_to_home_dot_codex() {
        let home = PathBuf::from("/h");
        assert_eq!(
            codex_home_from(Some("/custom".into()), home.clone()),
            PathBuf::from("/custom")
        );
        assert_eq!(
            codex_home_from(Some("".into()), home.clone()),
            PathBuf::from("/h/.codex")
        );
        assert_eq!(codex_home_from(None, home), PathBuf::from("/h/.codex"));
    }
}
