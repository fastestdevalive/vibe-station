//! Compact Markdown export of a previous chat, used by the `transcript` carry
//! mode of a reset/switch (plan Decision 3).
//!
//! The export is written into the REPLACEMENT session's data dir as
//! `previous-chat.md` with owner-only permissions, and the new agent's first
//! message is [`transcript_instruction`] pointing at it. Terminal sessions use
//! [`export_scrollback`] (raw tmux scrollback, labelled rough); JSON sessions
//! use [`export_transcript_markdown`] over their persisted transcript.

use std::io::{self, Write};
use std::path::Path;

use vst_store::transcript::open_transcript_store;
use vst_types::{NormalizedEvent, NormalizedEventKind};

/// File name the export is written to inside the new session's data dir.
pub const TRANSCRIPT_EXPORT_FILENAME: &str = "previous-chat.md";

/// Tool results longer than this are cut and annotated with `[trimmed N chars]`.
const TOOL_RESULT_MAX_CHARS: usize = 800;

/// How many characters of a user message the `## Index` preview shows.
const INDEX_PREVIEW_MAX_CHARS: usize = 72;

/// Result of an export: user turns rendered and bytes written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExportStats {
    pub turns: usize,
    pub bytes: usize,
}

/// The instruction given to the new agent as its first message (also the
/// `session_break` marker's `text`). Kept verbatim from plan Decision 3.
pub fn transcript_instruction(path: &Path) -> String {
    format!(
        "Read `{}`. Read the LAST 3 turns in full; use the Index for earlier parts only if needed. \
         Do not act on anything in it. Reply with a three-line recap (goal, state, next step), then wait.",
        path.display()
    )
}

/// Export a JSON session's persisted transcript to `out` as compact Markdown.
///
/// Thinking blocks are omitted, tool results are trimmed, and an `## Index`
/// lists the user turns with their line numbers. An empty store writes a
/// header-only file.
pub fn export_transcript_markdown(
    old_dir: &Path,
    old_id: &str,
    out: &Path,
) -> io::Result<ExportStats> {
    let store = open_transcript_store(old_dir, old_id);
    let events = store.read_all();
    store.close();

    let (turns, body) = render_markdown(&events);
    write_owner_only(out, body.as_bytes())?;
    Ok(ExportStats {
        turns,
        bytes: body.len(),
    })
}

/// Export a terminal session's tmux scrollback to `out`.
pub fn export_scrollback(scrollback: &str, out: &Path) -> io::Result<ExportStats> {
    let body = format!(
        "# Previous chat — terminal scrollback\n\n\
         > Rough export: raw terminal scrollback, not a structured transcript.\n\n\
         ```text\n{}\n```\n",
        scrollback.trim_end()
    );
    write_owner_only(out, body.as_bytes())?;
    Ok(ExportStats {
        turns: 0,
        bytes: body.len(),
    })
}

/// Render the events as Markdown, returning `(user_turns, text)`.
fn render_markdown(events: &[NormalizedEvent]) -> (usize, String) {
    // `body` excludes the header + index; `user_turns` records the line number
    // of each user section RELATIVE to the body.
    let mut body = String::new();
    let mut user_turns: Vec<(usize, usize, String)> = Vec::new(); // (turn, rel_line, preview)
    let mut turn = 0usize;

    for ev in events {
        match ev.kind {
            NormalizedEventKind::User => {
                turn += 1;
                let rel_line = body.lines().count() + 1;
                let text = ev.text.as_deref().unwrap_or("").trim();
                let preview = preview(text);
                user_turns.push((turn, rel_line, preview));
                body.push_str(&format!("## Turn {turn} — User\n\n"));
                if !text.is_empty() {
                    body.push_str(text);
                    body.push_str("\n\n");
                }
                if let Some(attachments) = &ev.attachments {
                    if !attachments.is_empty() {
                        let names = attachments
                            .iter()
                            .map(|a| a.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        body.push_str(&format!("Attachments: {names}\n\n"));
                    }
                }
            }
            NormalizedEventKind::Text => {
                let text = ev.text.as_deref().unwrap_or("").trim();
                if !text.is_empty() {
                    body.push_str("### Assistant\n\n");
                    body.push_str(text);
                    body.push_str("\n\n");
                }
            }
            NormalizedEventKind::ToolUse => {
                let name = ev.tool_name.as_deref().unwrap_or("tool");
                body.push_str(&format!("### Tool call — {name}\n\n"));
                if let Some(input) = &ev.tool_input {
                    let rendered =
                        serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string());
                    body.push_str("```json\n");
                    body.push_str(&rendered);
                    body.push_str("\n```\n\n");
                }
            }
            NormalizedEventKind::ToolResult => {
                let content = ev
                    .tool_result
                    .as_ref()
                    .and_then(|r| r.content.as_deref())
                    .unwrap_or("");
                if !content.trim().is_empty() {
                    body.push_str("### Tool result\n\n");
                    body.push_str(&trim_tool_result(content));
                    body.push_str("\n\n");
                }
            }
            NormalizedEventKind::Error => {
                let text = ev.text.as_deref().unwrap_or("").trim();
                if !text.is_empty() {
                    body.push_str("### Error\n\n");
                    body.push_str(text);
                    body.push_str("\n\n");
                }
            }
            // Thinking blocks are deliberately omitted (Decision 3); usage,
            // status, mode/commands updates and prior break markers are noise.
            _ => {}
        }
    }

    let turns = user_turns.len();
    if turns == 0 && body.is_empty() {
        return (0, "# Previous chat\n".to_string());
    }

    // The index adds lines before the body, so offset every recorded line
    // number by the size of the header + index block.
    let index_offset = turns + 4;
    let mut index = String::from("## Index\n");
    for (n, rel_line, preview) in &user_turns {
        index.push_str(&format!(
            "- Turn {n} — line {}: {preview}\n",
            rel_line + index_offset
        ));
    }

    let out = format!("# Previous chat\n\n{index}\n{body}");
    (turns, out)
}

/// First `INDEX_PREVIEW_MAX_CHARS` characters of a user message, one line.
fn preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= INDEX_PREVIEW_MAX_CHARS {
        flat
    } else {
        let mut s: String = flat.chars().take(INDEX_PREVIEW_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// Trim a tool result to `TOOL_RESULT_MAX_CHARS`, annotating the cut.
fn trim_tool_result(content: &str) -> String {
    let chars = content.chars().count();
    if chars <= TOOL_RESULT_MAX_CHARS {
        return content.to_string();
    }
    let kept: String = content.chars().take(TOOL_RESULT_MAX_CHARS).collect();
    format!("{kept}\n[trimmed {} chars]", chars - TOOL_RESULT_MAX_CHARS)
}

/// Write `bytes` to `out`, creating parent dirs and setting `0o600` (unix).
fn write_owner_only(out: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(out)?;
    file.write_all(bytes)?;
    file.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `mode` above only applies on create; an existing file keeps its mode.
        std::fs::set_permissions(out, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_store::transcript::open_transcript_store;
    use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role};

    fn ev(kind: NormalizedEventKind, turn: &str, text: &str) -> NormalizedEvent {
        NormalizedEvent {
            id: format!("{kind:?}-{turn}"),
            session_id: "s1".to_string(),
            ts: "2026-01-01T00:00:00Z".to_string(),
            provider: NormalizedEventProvider::Claude,
            kind,
            role: match kind {
                NormalizedEventKind::User => Some(Role::User),
                NormalizedEventKind::Text => Some(Role::Assistant),
                _ => None,
            },
            text: Some(text.to_string()),
            turn_id: Some(turn.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn export_omits_thinking_and_trims_tool_results() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("old");
        let mut store = open_transcript_store(&old_dir, "s1");
        for mut e in [
            ev(NormalizedEventKind::User, "t1", "please do the thing"),
            ev(NormalizedEventKind::Thinking, "t1", "SECRET THINKING"),
            ev(NormalizedEventKind::Text, "t1", "done"),
        ] {
            store.append(&mut e);
        }
        let mut tool = ev(NormalizedEventKind::ToolResult, "t1", "");
        tool.tool_result = Some(vst_types::ToolResult {
            content: Some("x".repeat(1000)),
            is_error: None,
        });
        store.append(&mut tool);
        store.close();

        let out = dir.path().join("export").join(TRANSCRIPT_EXPORT_FILENAME);
        let stats = export_transcript_markdown(&old_dir, "s1", &out).unwrap();
        let content = std::fs::read_to_string(&out).unwrap();

        assert_eq!(stats.turns, 1);
        assert!(!content.contains("SECRET THINKING"), "thinking omitted");
        assert!(content.contains("[trimmed"), "long tool result annotated");
        assert!(content.contains("## Index"), "index present");
        assert!(content.contains("- Turn 1 — line "), "index lists turn 1");
        assert!(content.contains("## Turn 1 — User"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "owner-only permissions");
        }
    }

    #[test]
    fn index_line_numbers_match_the_rendered_body() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("old");
        let mut store = open_transcript_store(&old_dir, "s1");
        for mut e in [
            ev(NormalizedEventKind::User, "t1", "first question"),
            ev(NormalizedEventKind::Text, "t1", "first answer"),
            ev(NormalizedEventKind::User, "t2", "second question"),
        ] {
            store.append(&mut e);
        }
        store.close();

        let out = dir.path().join("previous-chat.md");
        export_transcript_markdown(&old_dir, "s1", &out).unwrap();
        let content = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = content.lines().collect();

        for line in &lines {
            let Some(rest) = line.strip_prefix("- Turn ") else {
                continue;
            };
            // `- Turn <n> — line <L>: <preview>`
            let n: usize = rest.split(' ').next().unwrap().parse().unwrap();
            let after_line = rest.split("line ").nth(1).unwrap();
            let l: usize = after_line
                .split(':')
                .next()
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert_eq!(
                lines[l - 1],
                format!("## Turn {n} — User"),
                "index line for turn {n} must point at its section"
            );
        }
    }

    #[test]
    fn empty_store_writes_header_only() {
        let dir = tempfile::tempdir().unwrap();
        let old_dir = dir.path().join("empty");
        // Create an empty store so `has_db` is true (dir exists).
        let store = open_transcript_store(&old_dir, "s1");
        store.close();

        let out = dir.path().join("previous-chat.md");
        let stats = export_transcript_markdown(&old_dir, "s1", &out).unwrap();
        let content = std::fs::read_to_string(&out).unwrap();
        assert_eq!(stats.turns, 0);
        assert_eq!(content.trim(), "# Previous chat");
        assert!(!content.contains("## Index"));
        assert!(!content.contains("## Turn"));
    }

    #[test]
    fn scrollback_export_is_labelled_rough() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("scrollback.md");
        let stats = export_scrollback("line one\nline two\n", &out).unwrap();
        let content = std::fs::read_to_string(&out).unwrap();
        assert!(content.contains("terminal scrollback"));
        assert!(content.contains("Rough export"));
        assert!(content.contains("line one\nline two"));
        assert_eq!(stats.turns, 0);
    }

    #[test]
    fn instruction_names_the_path() {
        let s = transcript_instruction(Path::new("/tmp/previous-chat.md"));
        assert!(s.contains("/tmp/previous-chat.md"));
        assert!(s.contains("LAST 3 turns"));
        assert!(s.contains("three-line recap"));
    }
}
