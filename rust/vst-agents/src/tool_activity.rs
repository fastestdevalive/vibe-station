//! Tool call -> [`ToolActivity`]: the canonical "what is the agent doing"
//! summary shown on dashboard cards.
//!
//! This is the normaliser boundary for tool NAMES. CLIs disagree: Claude's
//! ACP adapter titles calls `Edit \`path\``/the raw command, opencode reports
//! `edit`/`bash`, cursor `editToolCall`, agy `view_file`/`run_command`. They
//! are all folded onto Claude's tool vocabulary here (falling back to the
//! structural ACP `tool_kind`), so the web label function never branches on a
//! CLI. Pure: no I/O, no state.

use serde_json::Value;
use vst_types::activity::ToolActivity;
use vst_types::{AcpToolKind, NormalizedEvent, ToolLocation};

/// Max characters kept for a free-form (unknown tool) name.
const NAME_MAX: usize = 40;
/// Max characters kept for `detail`.
const DETAIL_MAX: usize = 60;

/// Summary for a `tool_use` event, or `None` when it names nothing usable.
pub fn tool_activity_from_event(ev: &NormalizedEvent) -> Option<ToolActivity> {
    let name = canonical_name(
        ev.tool_name.as_deref(),
        ev.tool_kind,
        ev.tool_input.as_ref(),
    )?;
    let detail = tool_detail(
        &name,
        ev.tool_input.as_ref(),
        ev.tool_locations.as_deref().unwrap_or_default(),
    );
    Some(ToolActivity { name, detail })
}

/// Recompute the detail of an already-named tool from a later, refined input
/// (ACP sends the real arguments in a follow-up update).
pub fn refined_detail(
    name: &str,
    input: Option<&Value>,
    locations: &[ToolLocation],
) -> Option<String> {
    tool_detail(name, input, locations)
}

fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn canonical_name(
    raw: Option<&str>,
    kind: Option<AcpToolKind>,
    input: Option<&Value>,
) -> Option<String> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty());
    if let Some(r) = raw {
        if r.starts_with("mcp__") && r.matches("__").count() >= 2 {
            return Some(r.to_string());
        }
        let key = squash(r);
        let key = key.strip_suffix("toolcall").unwrap_or(&key);
        let known = match key {
            "edit" | "strreplace" | "strreplaceeditor" | "applypatch" | "patch" | "replace" => {
                Some("Edit")
            }
            "multiedit" => Some("MultiEdit"),
            "write" | "writefile" | "createfile" | "newfile" | "writetofile" => Some("Write"),
            "notebookedit" => Some("NotebookEdit"),
            "read" | "readfile" | "view" | "viewfile" | "cat" | "readlints" => Some("Read"),
            "bash" | "shell" | "run" | "runcommand" | "execute" | "terminal" | "exec" => {
                Some("Bash")
            }
            "grep" | "search" | "codesearch" | "ripgrep" | "rg" | "semsearch" => Some("Grep"),
            "glob" | "find" | "ls" | "list" | "listdir" | "findbyname" => Some("Glob"),
            "webfetch" | "fetch" => Some("WebFetch"),
            "websearch" => Some("WebSearch"),
            "task" | "agent" | "subagent" => Some("Task"),
            "todowrite" | "todoread" | "todo" | "updatetodos" => Some("TodoWrite"),
            "exitplanmode" | "plan" => Some("ExitPlanMode"),
            _ => None,
        };
        if let Some(k) = known {
            return Some(k.to_string());
        }
    }
    // A sub-agent call carries a `subagent_type` argument whatever its title.
    if input
        .and_then(Value::as_object)
        .is_some_and(|o| o.contains_key("subagent_type"))
    {
        return Some("Task".into());
    }
    // Structural fallback: ACP's own tool kind.
    let by_kind = match kind {
        Some(AcpToolKind::Edit | AcpToolKind::Move | AcpToolKind::Delete) => Some("Edit"),
        Some(AcpToolKind::Read) => Some("Read"),
        Some(AcpToolKind::Execute) => Some("Bash"),
        Some(AcpToolKind::Search) => Some("Grep"),
        Some(AcpToolKind::Fetch) => Some("WebFetch"),
        Some(AcpToolKind::Think) => Some("TodoWrite"),
        Some(AcpToolKind::SwitchMode) => Some("ExitPlanMode"),
        Some(AcpToolKind::Other) | None => None,
    };
    if let Some(k) = by_kind {
        return Some(k.to_string());
    }
    raw.map(|r| truncate(r.lines().next().unwrap_or(r), NAME_MAX))
}

fn str_field<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn tool_detail(name: &str, input: Option<&Value>, locations: &[ToolLocation]) -> Option<String> {
    let obj = input.and_then(Value::as_object);
    let detail = match name {
        "Edit" | "Write" | "MultiEdit" | "Read" | "NotebookEdit" => {
            let from_input = obj.and_then(|o| {
                str_field(
                    o,
                    &[
                        "file_path",
                        "filePath",
                        "notebook_path",
                        "path",
                        "target_file",
                        "targetFile",
                        "TargetFile",
                        "AbsolutePath",
                        "file",
                        "filename",
                    ],
                )
            });
            from_input
                .or_else(|| locations.first().map(|l| l.path.as_str()))
                .map(|p| basename(p).to_string())
        }
        "Bash" => obj
            .and_then(|o| str_field(o, &["command", "cmd", "CommandLine"]))
            .and_then(first_command_word),
        _ => name
            .strip_prefix("mcp__")
            .and_then(|rest| rest.split("__").next())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };
    detail
        .filter(|d| !d.is_empty())
        .map(|d| truncate(&d, DETAIL_MAX))
}

/// Drop leading `cd <dir> &&` / `cd <dir>;` steps (the interesting command
/// follows). A bare `cd <dir>` with nothing after it is left alone.
fn skip_leading_cd<'a, 'b>(mut words: &'b [&'a str]) -> &'b [&'a str] {
    loop {
        match words {
            ["cd", dir, rest @ ..] if dir.ends_with(';') && dir.len() > 1 && !rest.is_empty() => {
                words = rest
            }
            ["cd", _, sep, rest @ ..] if matches!(*sep, "&&" | ";") && !rest.is_empty() => {
                words = rest
            }
            _ => return words,
        }
    }
}

/// First word of a shell command, skipping leading `cd <dir> &&`, `VAR=value`
/// prefixes and `sudo`.
fn first_command_word(cmd: &str) -> Option<String> {
    let words: Vec<&str> = cmd.split_whitespace().collect();
    skip_leading_cd(&words)
        .iter()
        .find(|w| {
            let is_assign = w.split_once('=').is_some_and(|(k, _)| {
                !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_')
            });
            !is_assign && **w != "sudo"
        })
        .map(|w| basename(w).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn act(name: Option<&str>, kind: Option<AcpToolKind>, input: Value) -> Option<ToolActivity> {
        let mut ev = NormalizedEvent::default();
        ev.tool_name = name.map(str::to_string);
        ev.tool_kind = kind;
        ev.tool_input = Some(input);
        tool_activity_from_event(&ev)
    }

    fn pair(a: Option<ToolActivity>) -> (String, Option<String>) {
        let a = a.unwrap();
        (a.name, a.detail)
    }

    #[test]
    fn claude_names_and_details() {
        assert_eq!(
            pair(act(
                Some("Edit"),
                None,
                json!({"file_path": "/a/b/parseConfig.ts"})
            )),
            ("Edit".into(), Some("parseConfig.ts".into()))
        );
        assert_eq!(
            pair(act(Some("Bash"), None, json!({"command": "cd /x && ls"}))),
            ("Bash".into(), Some("ls".into()))
        );
        assert_eq!(
            pair(act(
                Some("Bash"),
                None,
                json!({"command": "cd x && cargo test"})
            )),
            ("Bash".into(), Some("cargo".into()))
        );
        assert_eq!(
            pair(act(
                Some("Bash"),
                None,
                json!({"command": "cd x; cd y && npm i"})
            )),
            ("Bash".into(), Some("npm".into()))
        );
        assert_eq!(
            pair(act(Some("Bash"), None, json!({"command": "cd x ; make"}))),
            ("Bash".into(), Some("make".into()))
        );
        // Nothing after the cd: it is the command.
        assert_eq!(
            pair(act(Some("Bash"), None, json!({"command": "cd /x"}))),
            ("Bash".into(), Some("cd".into()))
        );
        assert_eq!(
            pair(act(Some("Bash"), None, json!({"command": "cd /x &&"}))),
            ("Bash".into(), Some("cd".into()))
        );
        assert_eq!(
            pair(act(
                Some("Bash"),
                None,
                json!({"command": "FOO=1 sudo /usr/bin/make all"})
            )),
            ("Bash".into(), Some("make".into()))
        );
        assert_eq!(
            pair(act(Some("Grep"), None, json!({"pattern": "secret"}))),
            ("Grep".into(), None)
        );
        assert_eq!(
            pair(act(Some("mcp__github__create_issue"), None, json!({}))),
            ("mcp__github__create_issue".into(), Some("github".into()))
        );
    }

    #[test]
    fn acp_titles_fall_back_to_kind_and_locations() {
        let mut ev = NormalizedEvent::default();
        ev.tool_name = Some("Edit `/repo/src/main.rs`".into());
        ev.tool_kind = Some(AcpToolKind::Edit);
        ev.tool_locations = Some(vec![ToolLocation {
            path: "/repo/src/main.rs".into(),
            line: None,
        }]);
        assert_eq!(
            pair(tool_activity_from_event(&ev)),
            ("Edit".into(), Some("main.rs".into()))
        );
    }

    #[test]
    fn other_cli_vocabularies_map_to_claude_names() {
        assert_eq!(
            pair(act(Some("editToolCall"), None, json!({"path": "/x/a.ts"}))).0,
            "Edit"
        );
        assert_eq!(
            pair(act(Some("shellToolCall"), None, json!({"command": "ls"}))).0,
            "Bash"
        );
        assert_eq!(pair(act(Some("view_file"), None, json!({}))).0, "Read");
        assert_eq!(
            pair(act(
                Some("run_command"),
                None,
                json!({"CommandLine": "npm test"})
            ))
            .1,
            Some("npm".into())
        );
        assert_eq!(pair(act(Some("webfetch"), None, json!({}))).0, "WebFetch");
    }

    #[test]
    fn unknown_without_kind_keeps_truncated_name() {
        let long = "x".repeat(100);
        let (n, d) = pair(act(Some(&long), None, json!({})));
        assert_eq!(n.len(), NAME_MAX);
        assert_eq!(d, None);
        assert!(act(None, None, json!({})).is_none());
    }

    #[test]
    fn subagent_type_means_task() {
        assert_eq!(
            pair(act(
                Some("Explore the repo"),
                None,
                json!({"subagent_type": "Explore"})
            ))
            .0,
            "Task"
        );
    }

    #[test]
    fn refined_detail_reads_late_input() {
        assert_eq!(
            refined_detail("Read", Some(&json!({"file_path": "/a/README.md"})), &[]),
            Some("README.md".into())
        );
    }
}
