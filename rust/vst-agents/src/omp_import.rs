//! At-rest omp native-store adapter.
//! Reads an omp session `.jsonl` (upstream-documented `session.md`, version 3)
//! read-only and normalizes its COMPLETE terminal turns into `NormalizedEvent`s.
//!
//! A session file is an append-only JSONL of versioned entries threaded by
//! `parentId`. The importer walks the ACTIVE branch only — from the leaf (the
//! last physical entry that isn't a bookkeeping tail) back to the root via
//! `parentId` (Decision 3), then maps each path entry to events per the plan's
//! event-mapping table (Decisions 2–5). A turn (from its user entry) is only
//! emitted once COMPLETE — followed by a later user entry, a `session_exit`,
//! or an assistant message whose `stopReason` is a terminal one with every
//! `toolCall` resolved (the store dedups per `turn_id`, so a partial turn would
//! lose its tail). The returned watermark is an entry `id` (survives sibling
//! file copies), and the parse is two-pass and bounded (Decision 5).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;
use vst_types::{
    NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult, UsageInfo,
};

use crate::native_history_importer::{
    NativeHistoryImporter, NativeImportRequest, NativeImportResult,
};
use crate::util::{new_uuid_v4, now_iso_8601};

/// Refuse files larger than this (omp streams ~normal size; a runaway export is
/// a memory cliff if inlined). Decision 5.
pub const OMP_IMPORT_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Skip any single line larger than this without indexing it. Decision 5.
pub const OMP_IMPORT_MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Entry `type`s that never terminate the active branch: upstream appends these
/// to a non-leaf parent without moving the leaf. Decision 3.
const NON_LEAF_TYPES: [&str; 4] = ["model_usage", "label", "title_change", "credential_pin"];

/// A parsed upside of one index line (pass 1 reads only these fields — Decision 5).
#[derive(serde::Deserialize)]
struct IndexLine {
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "parentId")]
    parent_id: Option<String>,
    #[serde(default, rename = "type")]
    ty: Option<String>,
    /// omp stamps off-branch writes (e.g. background bash output after tree
    /// navigation) with the leaf that is actually active.
    #[serde(default, rename = "activeLeafId")]
    active_leaf_id: Option<String>,
}

/// A path-related raw line's location + linkage, populated by pass 1.
struct IndexEntry {
    offset: u64,
    len: usize,
    id: Option<String>,
    parent_id: Option<String>,
    ty: Option<String>,
    active_leaf_id: Option<String>,
}

/// What the caller mapped `NormalizedEventKind` from a payload.
type Kind = NormalizedEventKind;

// ---------------------------------------------------------------------------
// Helpers shared by the importer and the current-cursor query
// ---------------------------------------------------------------------------

/// Read every line's `{id, parentId, type}` + byte span (pass 1). Lines that
/// don't parse or exceed the line cap are skipped; a final fragment without a
/// trailing newline (omp mid-write) is ignored. None on an unreadable file.
fn build_index(path: &Path) -> Option<Vec<IndexEntry>> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut offset: u64 = 0;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            break;
        }
        // A final fragment without a trailing newline is an in-progress write.
        if !buf.ends_with(b"\n") {
            break;
        }
        let len = buf.len();
        if len > OMP_IMPORT_MAX_LINE_BYTES {
            offset += len as u64;
            continue;
        }
        let parsed: IndexLine = match serde_json::from_slice(&buf[..len - 1]) {
            Ok(p) => p,
            Err(_) => {
                offset += len as u64;
                continue;
            }
        };
        entries.push(IndexEntry {
            offset,
            len,
            id: parsed.id,
            parent_id: parsed.parent_id,
            ty: parsed.ty,
            active_leaf_id: parsed.active_leaf_id,
        });
        offset += len as u64;
    }
    Some(entries)
}

/// The active root→leaf branch (Decision 3). With no ids at all (legacy v1) the
/// file order is a linear chain; otherwise walk `parentId` from the leaf with a
/// visited-set (no depth cap).
fn active_path(index: &[IndexEntry]) -> Vec<usize> {
    let any_id = index
        .iter()
        .any(|e| e.id.as_deref().is_some_and(|s| !s.is_empty()));
    if !any_id {
        return (0..index.len()).collect();
    }
    let id_to_idx: HashMap<&str, usize> = index
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.id.as_deref().map(|id| (id, i)))
        .collect();
    // Leaf = the last entry's `activeLeafId` when it names a known entry (omp's own
    // `resolveSessionLeafId`), else the last physical entry with an id whose type
    // can end a branch.
    let mut leaf = None;
    for (i, e) in index.iter().enumerate() {
        let ty = e.ty.as_deref().unwrap_or("");
        if e.id.is_some() && !NON_LEAF_TYPES.contains(&ty) {
            leaf = Some(i);
        }
    }
    if let Some(active) = index
        .iter()
        .rev()
        .find(|e| e.id.is_some() || e.active_leaf_id.is_some())
        .and_then(|e| e.active_leaf_id.as_deref())
        .and_then(|id| id_to_idx.get(id).copied())
    {
        leaf = Some(active);
    }
    let Some(mut cur) = leaf else {
        return Vec::new();
    };
    let mut path = Vec::new();
    // `seen` bounds the walk to `index.len()` and breaks parent cycles; a separate
    // depth cap would silently drop the start of a long agentic session.
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(cur) {
            break;
        }
        path.push(cur);
        match index[cur]
            .parent_id
            .as_deref()
            .and_then(|p| id_to_idx.get(p).copied())
        {
            Some(parent) => {
                cur = parent;
            }
            None => break,
        }
    }
    path.reverse(); // root → leaf
    path
}

/// Fully parse the path entry at `offset..offset+len` (pass 2).
fn parse_at(entry: &IndexEntry, path: &Path) -> Option<Value> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(entry.offset)).ok()?;
    let mut buf = vec![0u8; entry.len];
    f.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Whether `v` is a `message` with the given role (accepts `/message/role` or `/role`).
fn msg_role(v: &Value) -> &str {
    v.pointer("/message/role")
        .or_else(|| v.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("")
}

/// A user entry that starts an importable turn: role `user` with `attribution`
/// absent or `"user"` (an `attribution:"agent"` message is injected knob-turn
/// feedback, not a typed prompt — skipped and never a turn boundary).
fn is_importable_user(v: &Value) -> bool {
    if msg_role(v) != "user" {
        return false;
    }
    let attr = v.pointer("/message/attribution").and_then(|a| a.as_str());
    attr.is_none() || attr == Some("user")
}

/// The turn id of a user entry (its entry `id`; legacy files have none, so the
/// caller falls back to a synthetic id).
fn user_turn_id(v: &Value) -> Option<String> {
    if is_importable_user(v) {
        v.get("id").and_then(|x| x.as_str()).map(str::to_string)
    } else {
        None
    }
}

fn is_assistant_message(v: &Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("message") && msg_role(v) == "assistant"
}

fn is_session_exit(v: &Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("custom")
        && v.get("customType").and_then(|t| t.as_str()) == Some("session_exit")
}

/// `content` as plain text: a string is one text block; an array joins `text`
/// blocks with `\n`, ignoring other block types (event-mapping table).
fn content_text(v: &Value) -> String {
    match v.pointer("/message/content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The model a `message`/`model_change` contributes: assistant `provider/model`,
/// else a bare `model_change.model`. None otherwise.
fn model_from(v: &Value) -> Option<String> {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("model_change") => v.get("model").and_then(|m| m.as_str()).map(str::to_string),
        Some("message") if is_assistant_message(v) => {
            let provider = v.pointer("/message/provider").and_then(|x| x.as_str());
            let model = v.pointer("/message/model").and_then(|x| x.as_str());
            match (provider, model) {
                (Some(p), Some(m)) => Some(format!("{p}/{m}")),
                (None, Some(m)) => Some(m.to_string()),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The assistant message's `toolCall` block ids (for completion resolution).
fn tool_call_ids(assistant: &Value) -> Vec<String> {
    assistant
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("toolCall"))
                .filter_map(|b| b.get("id").and_then(|x| x.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn tool_result_matches(v: &Value, id: &str) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("message")
        && msg_role(v) == "toolResult"
        && v.pointer("/message/toolCallId").and_then(|x| x.as_str()) == Some(id)
}

/// Whether a turn (its whole entry run) is complete (Decision 4).
fn turn_complete(turn: &[(usize, Value)], followed_by_later_user: bool) -> bool {
    if followed_by_later_user {
        return true;
    }
    // A session_exit in the turn lets a killed-mid-tool turn import (keeps a
    // dangling ToolUse, no result).
    if turn.iter().any(|(_, v)| is_session_exit(v)) {
        return true;
    }
    let Some((_, last_assistant)) = turn.iter().rev().find(|(_, v)| is_assistant_message(v)) else {
        return false;
    };
    let stop_ok = last_assistant
        .pointer("/message/stopReason")
        .and_then(|s| s.as_str())
        .is_some_and(|s| matches!(s, "stop" | "error" | "aborted" | "length"));
    let calls = tool_call_ids(last_assistant);
    let resolved = calls
        .iter()
        .all(|id| turn.iter().any(|(_, tv)| tool_result_matches(tv, id)));
    stop_ok && resolved
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

fn mk(
    session_id: &str,
    v: &Value,
    turn_id: &str,
    model: &str,
    kind: Kind,
    fill: impl FnOnce(&mut NormalizedEvent),
) -> NormalizedEvent {
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(now_iso_8601);
    let mut ev = NormalizedEvent {
        id: new_uuid_v4(),
        session_id: session_id.to_string(),
        ts,
        provider: NormalizedEventProvider::Omp,
        kind,
        turn_id: Some(turn_id.to_string()),
        model: (!model.is_empty()).then(|| model.to_string()),
        ..Default::default()
    };
    fill(&mut ev);
    ev
}

fn emit_block(
    b: &Value,
    session_id: &str,
    v: &Value,
    turn_id: &str,
    model: &str,
    out: &mut Vec<NormalizedEvent>,
) {
    match b.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
            // Whitespace-only blocks (real files carry `"\n\n"` lead text) are skipped.
            if !text.trim().is_empty() {
                out.push(mk(session_id, v, turn_id, model, Kind::Text, |e| {
                    e.role = Some(Role::Assistant);
                    e.text = Some(text.to_string());
                }));
            }
        }
        Some("thinking") => {
            let text = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
            if !text.trim().is_empty() {
                out.push(mk(session_id, v, turn_id, model, Kind::Thinking, |e| {
                    e.role = Some(Role::Assistant);
                    e.text = Some(text.to_string());
                }));
            }
        }
        Some("toolCall") => {
            let tool_id = b
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = b
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // `"i"` is omp's injected intent arg — never part of the tool input.
            let mut input = b.get("arguments").cloned().unwrap_or(Value::Null);
            if let Value::Object(map) = &mut input {
                map.remove("i");
            }
            out.push(mk(session_id, v, turn_id, model, Kind::ToolUse, |e| {
                e.role = Some(Role::Assistant);
                e.tool_id = Some(tool_id);
                e.tool_name = Some(tool_name);
                e.tool_input = Some(input);
            }));
        }
        _ => { /* other block types ignored */ }
    }
}

fn emit_usage(
    u: &Value,
    session_id: &str,
    v: &Value,
    turn_id: &str,
    model: &str,
    out: &mut Vec<NormalizedEvent>,
) {
    let total_tokens = u.get("totalTokens").and_then(|x| x.as_i64()).unwrap_or(0);
    if total_tokens == 0 {
        return;
    }
    let usage = UsageInfo {
        input_tokens: u.get("input").and_then(|x| x.as_i64()).unwrap_or(0),
        output_tokens: u.get("output").and_then(|x| x.as_i64()).unwrap_or(0),
        cache_read_tokens: u.get("cacheRead").and_then(|x| x.as_i64()).unwrap_or(0),
        cache_create_tokens: u.get("cacheWrite").and_then(|x| x.as_i64()).unwrap_or(0),
        total_tokens,
        context_window: None,
        cost_usd: u.pointer("/cost/total").and_then(|c| c.as_f64()),
        model: model.to_string(),
    };
    out.push(mk(session_id, v, turn_id, model, Kind::Usage, |e| {
        e.usage = Some(usage);
    }));
}

/// Emit every event for one complete turn (sharing its user entry's id). Also
/// advances `model` as entries are scanned, so usage/text picks up the right one.
fn emit_turn(
    turn: &[(usize, Value)],
    session_id: &str,
    turn_id: &str,
    model: &mut String,
    out: &mut Vec<NormalizedEvent>,
) {
    for (_, v) in turn {
        if let Some(m) = model_from(v) {
            *model = m;
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message") => match msg_role(v) {
                "user" => {
                    // Only importable users (attribution absent/"user") map to a
                    // User event; an `attribution:"agent"` injected entry is skipped.
                    if is_importable_user(v) {
                        let text = content_text(v);
                        if !text.trim().is_empty() {
                            out.push(mk(session_id, v, turn_id, model, Kind::User, |e| {
                                e.role = Some(Role::User);
                                e.text = Some(text);
                            }));
                        }
                    }
                }
                "assistant" => {
                    if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        for b in blocks {
                            emit_block(b, session_id, v, turn_id, model, out);
                        }
                    }
                    if let Some(usage) = v.pointer("/message/usage") {
                        emit_usage(usage, session_id, v, turn_id, model, out);
                    }
                    if v.pointer("/message/stopReason").and_then(|s| s.as_str()) == Some("error") {
                        let text = v
                            .pointer("/message/errorMessage")
                            .and_then(|e| e.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| "omp reported an error".to_string());
                        out.push(mk(session_id, v, turn_id, model, Kind::Error, |e| {
                            e.role = Some(Role::Assistant);
                            e.text = Some(text);
                        }));
                    }
                }
                "toolResult" => {
                    let tool_id = v
                        .pointer("/message/toolCallId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let content = content_text(v);
                    let is_error = v.pointer("/message/isError").and_then(|x| x.as_bool());
                    out.push(mk(session_id, v, turn_id, model, Kind::ToolResult, |e| {
                        e.tool_id = Some(tool_id);
                        e.tool_result = Some(ToolResult {
                            content: Some(content),
                            is_error,
                        });
                    }));
                }
                _ => {}
            },
            Some("compaction") => {
                // A compaction is its own turn: turn_id = the compaction entry id.
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or(turn_id);
                out.push(mk(session_id, v, id, model, Kind::Status, |e| {
                    e.text = Some("Conversation compacted".to_string());
                }));
            }
            // model_change / thinking_level_change / custom (incl. session_exit) /
            // reset_boundary / label / session / ... → no event.
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/// Import omp history from a session `.jsonl`. Returns `(events, next_watermark)`
/// where the watermark is an entry `id` (Decision 2). A missing/unreadable/oversize
/// file yields empty events and echoes the input watermark; the same watermark is
/// echoed when nothing new is emitted.
pub fn import_omp_history(
    path: &Path,
    session_id: &str,
    watermark: Option<&str>,
) -> (Vec<NormalizedEvent>, String) {
    let input_wm = watermark.unwrap_or("").to_string();
    let size_ok = std::fs::metadata(path)
        .map(|m| m.len() <= OMP_IMPORT_MAX_BYTES)
        .unwrap_or(false);
    if !size_ok {
        tracing::warn!(
            path = %path.display(),
            "omp history file missing or exceeds {} bytes; skipping import",
            OMP_IMPORT_MAX_BYTES
        );
        return (Vec::new(), input_wm);
    }
    let Some(index) = build_index(path) else {
        return (Vec::new(), input_wm);
    };
    let active = active_path(&index);
    if active.is_empty() {
        return (Vec::new(), input_wm);
    }

    // reset_boundary drops everything before it on the path (a `/clear` starts a
    // fresh transcript; matches omp's collapsed live view).
    let reset_pos = active
        .iter()
        .rposition(|&i| index[i].ty.as_deref() == Some("reset_boundary"));
    // Watermark start: when its id is on the current path, begin just after it;
    // an unknown/stale id re-emits the whole path (dedup is only a best-effort
    // backstop — Decision 2).
    let wm_start = watermark
        .and_then(|w| {
            active
                .iter()
                .position(|&i| index[i].id.as_deref() == Some(w))
        })
        .map_or(0, |i| i + 1);
    let seg_start = reset_pos.map_or(wm_start, |r| r.max(wm_start));

    // Pass 2: fully parse only the effective path entries (Decision 5).
    let mut parsed: Vec<(usize, Value)> = Vec::new();
    for (pos, &idx) in active.iter().enumerate() {
        if pos < seg_start {
            continue;
        }
        if let Some(v) = parse_at(&index[idx], path) {
            parsed.push((pos, v));
        }
    }

    let mut events: Vec<NormalizedEvent> = Vec::new();
    let mut model = String::new();
    let mut first_incomplete: Option<usize> = None; // path pos of the held turn's user
    let mut i = 0;
    while i < parsed.len() {
        if let Some(m) = model_from(&parsed[i].1) {
            model = m;
        }
        if !is_importable_user(&parsed[i].1) {
            i += 1; // non-turn marker (reset_boundary, injected user, custom) — no event
            continue;
        }
        // Legacy files have no entry ids, so fall back to a path-position id.
        let turn_id =
            user_turn_id(&parsed[i].1).unwrap_or_else(|| format!("legacy-{}", parsed[i].0));
        let mut j = i + 1;
        while j < parsed.len() && !is_importable_user(&parsed[j].1) {
            j += 1;
        }
        let followed_by_later_user = j < parsed.len();
        let turn = &parsed[i..j];
        if turn_complete(turn, followed_by_later_user) {
            emit_turn(turn, session_id, &turn_id, &mut model, &mut events);
        } else {
            first_incomplete = Some(parsed[i].0);
            break;
        }
        i = j;
    }

    let entry_id =
        |path_pos: usize| -> String { index[active[path_pos]].id.clone().unwrap_or_default() };
    let next_watermark = match first_incomplete {
        Some(user_pos) if user_pos > 0 => entry_id(user_pos - 1),
        // Held turn at the path root — nothing before it to point at.
        Some(_) => input_wm,
        // Nothing held: the last path entry (Decision 2).
        None => entry_id(active.len() - 1),
    };
    (events, next_watermark)
}

/// The id of the active branch's leaf — the cursor to seal the watermark when
/// leaving Rich Chat (Decision 9), i.e. what `import_omp_history` would return as
/// the watermark while treating the in-flight turn as complete. None when the
/// file is missing/oversize/unreadable.
pub fn omp_current_cursor(path: &Path) -> Option<String> {
    let size_ok = std::fs::metadata(path)
        .map(|m| m.len() <= OMP_IMPORT_MAX_BYTES)
        .unwrap_or(false);
    if !size_ok {
        return None;
    }
    let index = build_index(path)?;
    let active = active_path(&index);
    let leaf = *active.last()?;
    index[leaf].id.clone()
}

/// The shared omp importer: resolves the conversation via `omp::conversation_file`
/// and runs the two import passes (Decision 6 + 7).
pub struct OmpHistoryImporter;

impl NativeHistoryImporter for OmpHistoryImporter {
    fn cli(&self) -> &'static str {
        "omp"
    }

    fn import(&self, req: &NativeImportRequest) -> NativeImportResult {
        let Some(path) =
            crate::omp::conversation_file(Path::new(&req.cwd), &req.session_id, &req.agent_chat_id)
        else {
            return NativeImportResult {
                events: Vec::new(),
                next_watermark: req.watermark.clone().unwrap_or_default(),
            };
        };
        let (events, next_watermark) =
            import_omp_history(&path, &req.session_id, req.watermark.as_deref());
        NativeImportResult {
            events,
            next_watermark,
        }
    }

    fn current_cursor(&self, req: &NativeImportRequest) -> Option<String> {
        let path = crate::omp::conversation_file(
            Path::new(&req.cwd),
            &req.session_id,
            &req.agent_chat_id,
        )?;
        omp_current_cursor(&path)
    }
}

/// The shared default omp importer.
pub fn omp_history_importer() -> &'static dyn NativeHistoryImporter {
    static IMPORTER: std::sync::OnceLock<OmpHistoryImporter> = std::sync::OnceLock::new();
    IMPORTER.get_or_init(|| OmpHistoryImporter)
}
