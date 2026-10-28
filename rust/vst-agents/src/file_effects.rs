//! Path-bearing effects of a finished tool call: the ACP-generic default used by
//! [`AgentPlugin::extract_file_effects`](crate::plugin::AgentPlugin::extract_file_effects).
//!
//! Pure and I/O-free. Paths are reported exactly as the agent gave them; the
//! daemon resolves relative ones against the session cwd (R16). A shell call (ACP kind `execute`, or a shell-named tool with a string
//! `command`) is read by [`crate::shell_effects`]: common write forms with
//! literal or literal-variable paths become `Write`s; `rm`, scripts and language
//! runtimes are not parsed (they rely on `vst artifact add`). A shell call that
//! FAILED is still read (a non-zero exit after `> f` created `f`; the capture
//! pipeline only keeps targets that exist); any other failed call wrote nothing.

use serde_json::Value;
use vst_types::artifacts::FileEffect;
use vst_types::{AcpToolKind, ToolStatus};

use crate::normalize::is_write_tool_name;
use crate::shell_effects::shell_file_effects;
use crate::tool_call_tracker::MergedToolCall;

const PATH_KEYS: &[&str] = &[
    "file_path",
    "filePath",
    "path",
    "TargetFile",
    "targetFile",
    "target_file",
    "file",
    "filename",
];
const MOVE_FROM_KEYS: &[&str] = &[
    "source",
    "src",
    "from",
    "old_path",
    "oldPath",
    "source_path",
    "sourcePath",
];
const MOVE_TO_KEYS: &[&str] = &[
    "destination",
    "dest",
    "dst",
    "to",
    "new_path",
    "newPath",
    "destination_path",
    "destinationPath",
];

/// Default extraction: ACP `kind` plus `locations`, `diffs` and `rawInput`.
pub fn default_acp_effects(call: &MergedToolCall) -> Vec<FileEffect> {
    if ignores_failed(call) {
        return Vec::new();
    }
    match call.kind {
        Some(AcpToolKind::Edit) => writes(edited_paths(call)),
        Some(AcpToolKind::Delete) => unique_paths(
            call.locations
                .iter()
                .map(|l| l.path.clone())
                .chain(input_paths(call))
                .collect(),
        )
        .into_iter()
        .map(FileEffect::delete)
        .collect(),
        Some(AcpToolKind::Move) => move_effect(call).into_iter().collect(),
        Some(AcpToolKind::Other) | None => {
            let write_named = call.name.as_deref().is_some_and(is_write_tool_name);
            if write_named {
                writes(edited_paths(call))
            } else if call.name.as_deref().is_some_and(is_shell_tool_name) {
                shell_effects(call)
            } else {
                Vec::new()
            }
        }
        Some(AcpToolKind::Execute) => shell_effects(call),
        // Read, Search, Think, Fetch, SwitchMode: not file writes.
        Some(_) => Vec::new(),
    }
}

/// Is this a shell call (ACP `execute`, or a shell-named tool without a
/// more specific kind)?
pub fn is_shell_call(call: &MergedToolCall) -> bool {
    match call.kind {
        Some(AcpToolKind::Execute) => true,
        Some(AcpToolKind::Other) | None => call.name.as_deref().is_some_and(is_shell_tool_name),
        Some(_) => false,
    }
}

/// A failed call produced no effects, except a shell call: it may have
/// created files before it failed. Used by the default AND any plugin override.
pub fn ignores_failed(call: &MergedToolCall) -> bool {
    call.status == Some(ToolStatus::Failed) && !is_shell_call(call)
}

/// Effects of the shell `command` in the call's input (`Write`s, and `Move`s
/// for `mv`). Relative
/// targets resolve against the input's absolute `cwd` when it has one (codex),
/// otherwise they are skipped by the parser.
fn shell_effects(call: &MergedToolCall) -> Vec<FileEffect> {
    let Some(obj) = call.input.as_ref().and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(command) = obj.get("command").and_then(Value::as_str) else {
        return Vec::new();
    };
    let cwd = obj
        .get("cwd")
        .and_then(Value::as_str)
        .map(std::path::Path::new)
        .filter(|p| p.is_absolute());
    shell_file_effects(command, cwd)
}

fn is_shell_tool_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "bash"
            | "shell"
            | "terminal"
            | "sh"
            | "execute"
            | "run_terminal_cmd"
            | "run_shell_command"
            | "exec_command"
    )
}

/// Paths of an edit-like call: diffs, then locations, then `rawInput`.
pub fn edited_paths(call: &MergedToolCall) -> Vec<String> {
    unique_paths(
        call.diffs
            .iter()
            .map(|d| d.path.clone())
            .chain(call.locations.iter().map(|l| l.path.clone()))
            .chain(input_paths(call))
            .collect(),
    )
}

/// `Write` effects for each path.
pub fn writes(paths: Vec<String>) -> Vec<FileEffect> {
    paths.into_iter().map(FileEffect::write).collect()
}

fn move_effect(call: &MergedToolCall) -> Option<FileEffect> {
    if call.locations.len() >= 2 {
        return Some(FileEffect::moved(
            call.locations[0].path.clone(),
            call.locations[1].path.clone(),
        ));
    }
    let obj = call.input.as_ref()?.as_object()?;
    let from = first_str(obj, MOVE_FROM_KEYS)?;
    let to = first_str(obj, MOVE_TO_KEYS)?;
    Some(FileEffect::moved(from, to))
}

fn input_paths(call: &MergedToolCall) -> Vec<String> {
    let Some(obj) = call.input.as_ref().and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    if let Some(p) = first_str(obj, PATH_KEYS) {
        out.push(p);
    }
    if let Some(Value::Array(items)) = obj.get("paths") {
        out.extend(
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string),
        );
    }
    out
}

fn first_str(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match obj.get(*k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    })
}

/// Drop empty paths and duplicates, keeping first-seen order.
pub fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty() && seen.insert(p.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vst_types::{ToolDiff, ToolLocation};

    fn call(kind: Option<AcpToolKind>) -> MergedToolCall {
        MergedToolCall {
            tool_id: "t".into(),
            kind,
            ..Default::default()
        }
    }
    fn loc(p: &str) -> ToolLocation {
        ToolLocation {
            path: p.into(),
            line: None,
        }
    }
    fn diff(p: &str) -> ToolDiff {
        ToolDiff {
            path: p.into(),
            old_text: None,
            new_text: "x".into(),
            old_start: None,
            new_start: None,
        }
    }

    #[test]
    fn edit_with_diff_is_write() {
        let mut c = call(Some(AcpToolKind::Edit));
        c.diffs = vec![diff("/a/x.md")];
        c.locations = vec![loc("/a/x.md")];
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("/a/x.md")]);
    }

    #[test]
    fn edit_with_only_locations_or_input_is_write() {
        let mut c = call(Some(AcpToolKind::Edit));
        c.locations = vec![loc("rel/x.md")];
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("rel/x.md")]);
        let mut c = call(Some(AcpToolKind::Edit));
        c.input = Some(json!({"file_path": "/a/y.md"}));
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("/a/y.md")]);
    }

    #[test]
    fn multi_file_edit_yields_one_write_per_distinct_path() {
        let mut c = call(Some(AcpToolKind::Edit));
        c.diffs = vec![diff("/a/1.md"), diff("/a/2.md"), diff("/a/1.md")];
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::write("/a/1.md"), FileEffect::write("/a/2.md")]
        );
    }

    #[test]
    fn delete_kind_is_delete() {
        let mut c = call(Some(AcpToolKind::Delete));
        c.locations = vec![loc("/a/gone.md")];
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::delete("/a/gone.md")]
        );
    }

    #[test]
    fn move_kind_uses_locations_then_input_keys() {
        let mut c = call(Some(AcpToolKind::Move));
        c.locations = vec![loc("/a/old.md"), loc("/a/new.md")];
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::moved("/a/old.md", "/a/new.md")]
        );
        let mut c = call(Some(AcpToolKind::Move));
        c.input = Some(json!({"source": "/a/o.md", "destination": "/a/n.md"}));
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::moved("/a/o.md", "/a/n.md")]
        );
        assert!(default_acp_effects(&call(Some(AcpToolKind::Move))).is_empty());
    }

    #[test]
    fn non_file_kinds_yield_nothing() {
        for k in [
            AcpToolKind::Read,
            AcpToolKind::Search,
            AcpToolKind::Fetch,
            AcpToolKind::Think,
        ] {
            let mut c = call(Some(k));
            c.locations = vec![loc("/a/x.md")];
            c.input = Some(json!({"file_path": "/a/x.md", "command": "cat > x"}));
            assert!(default_acp_effects(&c).is_empty(), "{k:?}");
        }
    }

    #[test]
    fn execute_kind_parses_shell_writes() {
        let mut c = call(Some(AcpToolKind::Execute));
        c.input = Some(json!({"command": "echo hi > /tmp/o/a.md && cp a /tmp/o/"}));
        assert_eq!(
            default_acp_effects(&c),
            vec![
                FileEffect::write("/tmp/o/a.md"),
                FileEffect::write("/tmp/o/a")
            ]
        );
        // Relative targets use the input cwd when absolute, else are skipped.
        c.input = Some(json!({"command": "cat > a.md", "cwd": "/w"}));
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("/w/a.md")]);
        c.input = Some(json!({"command": "cat > a.md", "cwd": "rel"}));
        assert!(default_acp_effects(&c).is_empty());
        c.input = Some(json!({"command": "ls"}));
        assert!(default_acp_effects(&c).is_empty());
        c.input = None;
        assert!(default_acp_effects(&c).is_empty());
        let mut c = call(None);
        c.name = Some("Bash".into());
        c.input = Some(json!({"command": "echo > /tmp/o/b.md"}));
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::write("/tmp/o/b.md")]
        );
    }

    #[test]
    fn failed_calls_yield_effects_only_for_shell() {
        let mut c = call(Some(AcpToolKind::Execute));
        c.status = Some(ToolStatus::Failed);
        c.input = Some(json!({"command": "echo > /tmp/o/a.md && false"}));
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::write("/tmp/o/a.md")]
        );
        let mut c = call(None);
        c.name = Some("Bash".into());
        c.status = Some(ToolStatus::Failed);
        c.input = Some(json!({"command": "echo > /tmp/o/b.md"}));
        assert_eq!(
            default_acp_effects(&c),
            vec![FileEffect::write("/tmp/o/b.md")]
        );
        for k in [
            AcpToolKind::Edit,
            AcpToolKind::Delete,
            AcpToolKind::Move,
            AcpToolKind::Other,
        ] {
            let mut c = call(Some(k));
            c.status = Some(ToolStatus::Failed);
            c.locations = vec![loc("/a/x.md"), loc("/a/y.md")];
            c.diffs = vec![diff("/a/x.md")];
            c.input = Some(json!({"file_path": "/a/x.md", "command": "echo > /a/z"}));
            assert!(default_acp_effects(&c).is_empty(), "{k:?}");
            assert!(ignores_failed(&c), "{k:?}");
        }
        let mut c = call(Some(AcpToolKind::Edit));
        c.status = Some(ToolStatus::Completed);
        c.locations = vec![loc("/a/x.md")];
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("/a/x.md")]);
    }

    #[test]
    fn write_named_tool_without_kind_counts() {
        let mut c = call(None);
        c.name = Some("write_file".into());
        c.input = Some(json!({"path": "/a/w.md", "content": "x"}));
        assert_eq!(default_acp_effects(&c), vec![FileEffect::write("/a/w.md")]);
        let mut c = call(None);
        c.name = Some("Reading".into());
        c.input = Some(json!({"path": "/a/w.md"}));
        assert!(default_acp_effects(&c).is_empty());
    }
}
