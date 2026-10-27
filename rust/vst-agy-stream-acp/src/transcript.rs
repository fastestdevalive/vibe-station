//! Lookup of file-edit arguments in agy's per-conversation transcript.
//!
//! This is the ONLY module that knows the transcript format. Why it exists:
//! in stream-json mode agy's `write_file`/`edit_file` tool events carry only
//! `{"Path": …}` — no content — so the text needed for a UI diff has to come
//! from the transcript agy keeps on disk (read-only for us):
//!
//! ```text
//! $HOME/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/
//!   transcript_full.jsonl   one JSON row per step, RAW argument strings
//!   transcript.jsonl        same rows, argument strings JSON-ENCODED
//!                           (`"\"hi\""`), long values truncated
//! ```
//!
//! A row that issued tools looks like
//! `{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"edit_file",
//! "args":{"Path":…,"Target":…,"Replacement":…}}]}`; a row whose values were cut
//! carries `"truncated_fields":["tool_calls"]`.
//!
//! The row right after an `edit_file` call is a `GENERIC` result row (its
//! `step_index` equals the stream's tool `step_index`) whose `content` ends
//! `Made N replacement(s) in <path> starting at line L (+a/-b lines).`; that
//! is the only trustworthy source of the real line number (see
//! [`parse_edit_result`]).
//!
//! Verified against agy 1.4.7. Everything here is best effort: any problem
//! (missing/huge/malformed file, unknown tool, truncated value) yields `None`
//! and a debug log — a diff is a nicety and must never fail a turn.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Largest transcript file we are willing to scan.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Largest single text (content / target / replacement) we put in a diff.
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// Identifies one `tool_calls` entry: (row `step_index`, index in that row).
pub type CallKey = (i64, usize);

/// agy's own report of an `edit_file` outcome: `Made {count} replacement(s)
/// in <path> starting at line {line}`. `line` is the 1-based line of the FIRST
/// replacement (the same in the old and the new file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditResult {
    pub count: usize,
    pub line: usize,
}

/// What a file tool changed, as recorded in the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEdit {
    pub path: String,
    /// `None` for `write_file` (agy gives no pre-image).
    pub old_text: Option<String>,
    pub new_text: String,
    /// `edit_file` only: the parsed result row, `None` when missing/unparsable.
    pub result: Option<EditResult>,
    /// True when ANY tool call other than a pure read follows this one in the
    /// transcript (same row, later index; or a later row). The file on disk may
    /// then already contain that call's changes, so it must not be read to
    /// derive line numbers.
    pub later_calls: bool,
    /// The transcript file this edit was read from and its size at that
    /// moment, so a caller can detect that it has grown since.
    pub source: Option<(PathBuf, u64)>,
}

/// True when the transcript at `source` is longer than when it was scanned.
#[must_use]
pub fn transcript_grew(source: &(PathBuf, u64)) -> bool {
    std::fs::metadata(&source.0).map_or(true, |m| m.len() != source.1)
}

/// True for the tool names this module can resolve.
#[must_use]
pub fn supports(tool_name: &str) -> bool {
    matches!(tool_name, "write_file" | "edit_file")
}

/// Find the latest not-yet-consumed transcript call named `tool_name` whose
/// `Path` equals `path`. `step_index` is the stream's tool step, used to find
/// the call's result row.
#[must_use]
pub fn find_edit(
    home: &Path,
    conversation_id: &str,
    tool_name: &str,
    path: &str,
    step_index: i64,
    consumed: &HashSet<CallKey, impl std::hash::BuildHasher>,
) -> Option<(CallKey, FileEdit)> {
    if !supports(tool_name) || !valid_conversation_id(conversation_id) {
        return None;
    }
    let dir = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("brain")
        .join(conversation_id)
        .join(".system_generated")
        .join("logs");
    // Prefer the full transcript; fall back to the truncating one.
    for (file, encoded) in [("transcript_full.jsonl", false), ("transcript.jsonl", true)] {
        let candidate = dir.join(file);
        match scan(&candidate, encoded, tool_name, path, step_index, consumed) {
            Scan::Found(found) => return Some(found),
            Scan::Unusable => return None,
            Scan::NoMatch => {}
        }
    }
    tracing::debug!(tool_name, path, "no transcript call matched");
    None
}

/// Plain uuid-like token only: nothing that could escape the brain dir.
fn valid_conversation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

enum Scan {
    Found((CallKey, FileEdit)),
    /// A call matched but cannot be used (too large): stop, don't fall back.
    Unusable,
    NoMatch,
}

fn scan(
    file: &PathBuf,
    encoded: bool,
    tool_name: &str,
    path: &str,
    step_index: i64,
    consumed: &HashSet<CallKey, impl std::hash::BuildHasher>,
) -> Scan {
    let Ok(meta) = std::fs::metadata(file) else {
        return Scan::NoMatch;
    };
    // Regular files only: opening a FIFO or device node could block forever.
    if !meta.is_file() {
        tracing::debug!(file = %file.display(), "transcript is not a regular file; skipping diff");
        return Scan::NoMatch;
    }
    if meta.len() > MAX_FILE_BYTES {
        tracing::debug!(file = %file.display(), "transcript too large; skipping diff");
        return Scan::NoMatch;
    }
    let Ok(handle) = File::open(file) else {
        return Scan::NoMatch;
    };
    let mut best: Option<(CallKey, Value)> = None;
    // `content` of rows that look like an edit result, by row step_index.
    let mut results: HashMap<i64, String> = HashMap::new();
    // Every tool call seen, to tell whether any follows the chosen one.
    // Truncated rows count as an unknown (mutating-capable) call.
    let mut all_calls: Vec<(CallKey, bool)> = Vec::new();
    let mut reader = BufReader::new(handle);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => {
                tracing::debug!(file = %file.display(), "unreadable transcript line");
                break;
            }
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            tracing::debug!("non-UTF-8 transcript line skipped");
            continue;
        };
        if line.contains("starting at line") {
            if let Some((index, content)) = result_row(line) {
                results.insert(index, content);
            }
        }
        // Cheap pre-filter: most rows have no tool call at all.
        if !line.contains("\"tool_calls\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            tracing::debug!("malformed transcript line skipped");
            continue;
        };
        let Some(step_index) = row.get("step_index").and_then(Value::as_i64) else {
            continue;
        };
        if row_truncated(&row) {
            all_calls.push(((step_index, 0), true));
            continue;
        }
        let Some(calls) = row.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for (index, call) in calls.iter().enumerate() {
            let read_only = matches!(
                call.get("name").and_then(Value::as_str),
                Some("read_file" | "view_file")
            );
            all_calls.push(((step_index, index), !read_only));
        }
        // Lowest unused index first within a row, so same-name+Path calls in
        // one row are matched in the order they were issued.
        for (index, call) in calls.iter().enumerate() {
            let key = (step_index, index);
            if consumed.contains(&key)
                || call.get("name").and_then(Value::as_str) != Some(tool_name)
            {
                continue;
            }
            let Some(args) = call.get("args") else {
                continue;
            };
            if arg(args, "Path", encoded).as_deref() != Some(path) {
                continue;
            }
            if best
                .as_ref()
                .map_or(true, |(k, _)| key.0 > k.0 || (key.0 == k.0 && key.1 < k.1))
            {
                best = Some((key, args.clone()));
            }
        }
    }
    let Some((key, args)) = best else {
        return Scan::NoMatch;
    };
    match build_edit(tool_name, path, &args, encoded) {
        Some(mut edit) => {
            if tool_name == "edit_file" && step_index > key.0 {
                // The result row must come AFTER the matched planner row.
                edit.result = results.get(&step_index).and_then(|content| {
                    parse_edit_result(content, path).or_else(|| {
                        // transcript.jsonl JSON-encodes values.
                        parse_edit_result(&serde_json::from_str::<String>(content).ok()?, path)
                    })
                });
            }
            edit.later_calls = all_calls
                .iter()
                .any(|(other, mutating)| *mutating && *other > key);
            edit.source = Some((file.clone(), meta.len()));
            Scan::Found((key, edit))
        }
        None => Scan::Unusable,
    }
}

/// `(step_index, content)` of a row with a string `content`.
fn result_row(line: &str) -> Option<(i64, String)> {
    let row = serde_json::from_str::<Value>(line).ok()?;
    if row.get("type")?.as_str()? != "GENERIC" {
        return None;
    }
    let index = row.get("step_index")?.as_i64()?;
    let content = row.get("content")?.as_str()?;
    Some((index, content.to_string()))
}

/// Parse the `Made N replacement(s) in <path> starting at line L …` line of an
/// `edit_file` result row. Tolerant of the surrounding lines; `None` when it
/// is absent, malformed, zero-valued, or names a different `path`.
#[must_use]
pub fn parse_edit_result(content: &str, path: &str) -> Option<EditResult> {
    content.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Made ")?;
        let (count, rest) = split_number(rest)?;
        let rest = rest.strip_prefix(" replacement")?;
        let rest = rest.strip_prefix('s').unwrap_or(rest);
        let rest = rest.strip_prefix(" in ")?;
        let (named, tail) = rest.rsplit_once(" starting at line ")?;
        let (line_no, _) = split_number(tail)?;
        (named == path && count >= 1 && line_no >= 1).then_some(EditResult {
            count,
            line: line_no,
        })
    })
}

/// Leading ASCII digits as a number, and the remainder.
fn split_number(text: &str) -> Option<(usize, &str)> {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let number = text[..end].parse().ok()?;
    Some((number, &text[end..]))
}

fn row_truncated(row: &Value) -> bool {
    row.get("truncated_fields")
        .and_then(Value::as_array)
        .is_some_and(|fields| fields.iter().any(|f| f.as_str() == Some("tool_calls")))
}

/// One argument as text. `transcript.jsonl` JSON-encodes every value
/// (`"\"hi\""`): decode it, keeping the raw string if it is not an encoded
/// string. `transcript_full.jsonl` values are raw and never decoded.
fn arg(args: &Value, key: &str, encoded: bool) -> Option<String> {
    let raw = args.get(key)?.as_str()?;
    if encoded {
        Some(serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string()))
    } else {
        Some(raw.to_string())
    }
}

fn build_edit(tool_name: &str, path: &str, args: &Value, encoded: bool) -> Option<FileEdit> {
    let capped = |text: String| (text.len() <= MAX_TEXT_BYTES).then_some(text);
    let (old_text, new_text) = match tool_name {
        "write_file" => (None, capped(arg(args, "Content", encoded)?)?),
        "edit_file" => (
            Some(capped(arg(args, "Target", encoded)?)?),
            capped(arg(args, "Replacement", encoded)?)?,
        ),
        _ => return None,
    };
    Some(FileEdit {
        path: path.to_string(),
        old_text,
        new_text,
        result: None,
        later_calls: false,
        source: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONV: &str = "11111111-2222-3333-4444-555555555555";
    const FULL: &str = include_str!("../tests/fixtures/transcript_full.jsonl");
    const SHORT: &str = include_str!("../tests/fixtures/transcript_short.jsonl");
    const TRUNCATED: &str = include_str!("../tests/fixtures/transcript_truncated.jsonl");

    fn home_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::tempdir().expect("tempdir");
        let dir = home
            .path()
            .join(".gemini/antigravity-cli/brain")
            .join(CONV)
            .join(".system_generated/logs");
        std::fs::create_dir_all(&dir).expect("logs dir");
        for (name, body) in files {
            std::fs::write(dir.join(name), body).expect("write transcript");
        }
        home
    }

    fn none() -> HashSet<CallKey> {
        HashSet::new()
    }

    #[test]
    fn write_file_has_no_old_text() {
        let home = home_with(&[("transcript_full.jsonl", FULL)]);
        let (key, edit) = find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none(),
        )
        .unwrap();
        assert_eq!(key, (1, 0));
        assert_eq!(edit.old_text, None);
        assert_eq!(edit.new_text, "hi there");
        assert_eq!(edit.path, "/tmp/x/hello.txt");
    }

    #[test]
    fn edit_file_uses_target_and_replacement_and_consumed_set_picks_successive_calls() {
        let home = home_with(&[("transcript_full.jsonl", FULL)]);
        let mut consumed = none();
        let (key, edit) = find_edit(
            home.path(),
            CONV,
            "edit_file",
            "/tmp/x/hello.txt",
            0,
            &consumed,
        )
        .unwrap();
        // Latest call first (step 5), then the earlier one (step 3).
        assert_eq!(key, (5, 0));
        assert_eq!(edit.old_text.as_deref(), Some("bye"));
        assert_eq!(edit.new_text, "bye bye");
        consumed.insert(key);
        let (key, edit) = find_edit(
            home.path(),
            CONV,
            "edit_file",
            "/tmp/x/hello.txt",
            0,
            &consumed,
        )
        .unwrap();
        assert_eq!(key, (3, 0));
        assert_eq!(edit.old_text.as_deref(), Some("hi"));
        assert_eq!(edit.new_text, "bye");
        consumed.insert(key);
        assert!(find_edit(
            home.path(),
            CONV,
            "edit_file",
            "/tmp/x/hello.txt",
            0,
            &consumed
        )
        .is_none());
    }

    #[test]
    fn other_path_or_tool_does_not_match() {
        let home = home_with(&[("transcript_full.jsonl", FULL)]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/other.txt",
            0,
            &none()
        )
        .is_none());
        assert!(find_edit(
            home.path(),
            CONV,
            "read_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_none());
        assert!(find_edit(
            home.path(),
            CONV,
            "replace_file_content",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_none());
    }

    #[test]
    fn short_transcript_values_are_json_decoded() {
        let home = home_with(&[("transcript.jsonl", SHORT)]);
        let (_, edit) = find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none(),
        )
        .unwrap();
        assert_eq!(edit.new_text, "hi there");
        let (_, edit) = find_edit(
            home.path(),
            CONV,
            "edit_file",
            "/tmp/x/hello.txt",
            0,
            &none(),
        )
        .unwrap();
        assert_eq!(edit.old_text.as_deref(), Some("hi"));
        assert_eq!(edit.new_text, "bye");
    }

    #[test]
    fn full_transcript_values_are_not_decoded() {
        // A raw value that merely looks JSON-encoded must stay as written.
        let home = home_with(&[("transcript_full.jsonl", FULL)]);
        let (_, edit) = find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/quoted.txt",
            0,
            &none(),
        )
        .unwrap();
        assert_eq!(edit.new_text, "\"quoted\"");
    }

    #[test]
    fn truncated_only_transcript_yields_none() {
        let home = home_with(&[("transcript.jsonl", TRUNCATED)]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/big.txt",
            0,
            &none()
        )
        .is_none());
    }

    #[test]
    fn full_transcript_wins_over_truncated_short_one() {
        let home = home_with(&[
            ("transcript_full.jsonl", FULL),
            ("transcript.jsonl", TRUNCATED),
        ]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_some());
    }

    #[test]
    fn missing_files_yield_none() {
        let home = tempfile::tempdir().unwrap();
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_none());
    }

    #[test]
    fn bad_conversation_ids_are_rejected() {
        let home = home_with(&[("transcript_full.jsonl", FULL)]);
        for id in ["", "..", "../x", "a/b", "a b", "x\\y"] {
            assert!(
                find_edit(
                    home.path(),
                    id,
                    "write_file",
                    "/tmp/x/hello.txt",
                    0,
                    &none()
                )
                .is_none(),
                "{id:?} must be rejected"
            );
        }
    }

    #[test]
    fn malformed_lines_are_tolerated() {
        let body = format!("not json\n{{\"tool_calls\": oops\n{{\"tool_calls\":[]}}\n{FULL}");
        let home = home_with(&[("transcript_full.jsonl", &body)]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_some());
    }

    #[test]
    fn same_row_calls_are_consumed_lowest_index_first() {
        let row = serde_json::json!({
            "step_index": 7,
            "tool_calls": [
                {"name": "edit_file", "args": {"Path": "/tmp/x/a.txt", "Target": "a", "Replacement": "b"}},
                {"name": "edit_file", "args": {"Path": "/tmp/x/a.txt", "Target": "b", "Replacement": "c"}}
            ]
        });
        let home = home_with(&[("transcript_full.jsonl", &format!("{row}\n"))]);
        let mut consumed = none();
        let (key, edit) =
            find_edit(home.path(), CONV, "edit_file", "/tmp/x/a.txt", 0, &consumed).unwrap();
        assert_eq!(key, (7, 0));
        assert_eq!(edit.old_text.as_deref(), Some("a"));
        consumed.insert(key);
        let (key, edit) =
            find_edit(home.path(), CONV, "edit_file", "/tmp/x/a.txt", 0, &consumed).unwrap();
        assert_eq!(key, (7, 1));
        assert_eq!(edit.old_text.as_deref(), Some("b"));
        consumed.insert(key);
        assert!(find_edit(home.path(), CONV, "edit_file", "/tmp/x/a.txt", 0, &consumed).is_none());
    }

    #[test]
    fn invalid_utf8_line_is_skipped_and_reading_continues() {
        let mut bytes = b"{\"tool_calls\": \"\xff\xfe\"}\n".to_vec();
        bytes.extend_from_slice(FULL.as_bytes());
        let home = home_with(&[]);
        let dir = home
            .path()
            .join(".gemini/antigravity-cli/brain")
            .join(CONV)
            .join(".system_generated/logs");
        std::fs::write(dir.join("transcript_full.jsonl"), bytes).unwrap();
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_some());
    }

    #[test]
    fn non_regular_transcript_is_skipped() {
        // A directory named like the transcript must be treated as a miss.
        let home = home_with(&[]);
        let dir = home
            .path()
            .join(".gemini/antigravity-cli/brain")
            .join(CONV)
            .join(".system_generated/logs");
        std::fs::create_dir(dir.join("transcript_full.jsonl")).unwrap();
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_none());
    }

    #[test]
    fn oversized_text_yields_none() {
        let big = "a".repeat(MAX_TEXT_BYTES + 1);
        let row = serde_json::json!({
            "step_index": 1,
            "tool_calls": [{"name": "write_file", "args": {"Path": "/tmp/x/big.txt", "Content": big}}]
        });
        let home = home_with(&[("transcript_full.jsonl", &format!("{row}\n"))]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/big.txt",
            0,
            &none()
        )
        .is_none());
    }

    #[test]
    fn oversized_file_yields_none() {
        let pad = "x".repeat(1024 * 1024);
        let mut body = String::from(FULL);
        let filler = format!("{{\"step_index\":9,\"content\":\"{pad}\"}}\n");
        while (body.len() as u64) <= MAX_FILE_BYTES {
            body.push_str(&filler);
        }
        let home = home_with(&[("transcript_full.jsonl", &body)]);
        assert!(find_edit(
            home.path(),
            CONV,
            "write_file",
            "/tmp/x/hello.txt",
            0,
            &none()
        )
        .is_none());
    }

    const MADE: &str = "Created At: t\nCompleted At: t\nMade 1 replacement in /tmp/x/a.txt starting at line 3 (+1/-2 lines).";

    #[test]
    fn result_parser_handles_singular_and_plural() {
        let one = parse_edit_result(MADE, "/tmp/x/a.txt").unwrap();
        assert_eq!((one.count, one.line), (1, 3));
        let two = parse_edit_result(
            "Made 2 replacements in /tmp/x/a.txt starting at line 12 (+2/-2 lines).",
            "/tmp/x/a.txt",
        )
        .unwrap();
        assert_eq!((two.count, two.line), (2, 12));
    }

    #[test]
    fn result_parser_rejects_wrong_path_and_garbage() {
        assert!(parse_edit_result(MADE, "/tmp/x/other.txt").is_none());
        for bad in [
            "",
            "Created file.",
            "Made 0 replacements in /tmp/x/a.txt starting at line 3",
            "Made 1 replacement in /tmp/x/a.txt starting at line 0",
            "Made x replacements in /tmp/x/a.txt starting at line 3",
            "Made 1 replacement in /tmp/x/a.txt starting at line",
            "Made 1 replacement in /tmp/x/a.txt",
            "Made 99999999999999999999999 replacements in /tmp/x/a.txt starting at line 3",
        ] {
            assert!(parse_edit_result(bad, "/tmp/x/a.txt").is_none(), "{bad:?}");
        }
        // A path that itself contains the separator still matches exactly.
        let odd = "Made 1 replacement in /tmp/x/a starting at line 9.txt starting at line 4 (+0/-0 lines).";
        assert_eq!(
            parse_edit_result(odd, "/tmp/x/a starting at line 9.txt").map(|r| r.line),
            Some(4)
        );
    }

    fn edit_rows(result_step: i64, content: &str) -> String {
        let call = serde_json::json!({
            "step_index": 4,
            "type": "PLANNER_RESPONSE",
            "tool_calls": [{"name": "edit_file", "args": {"Path": "/tmp/x/a.txt", "Target": "a", "Replacement": "b"}}]
        });
        let result =
            serde_json::json!({"step_index": result_step, "type": "GENERIC", "content": content});
        format!("{call}\n{result}\n")
    }

    #[test]
    fn find_edit_attaches_the_result_row_by_stream_step_only() {
        // Stream step 5 == result row 5.
        let home = home_with(&[("transcript_full.jsonl", &edit_rows(5, MADE))]);
        let path = "/tmp/x/a.txt";
        let (_, edit) = find_edit(home.path(), CONV, "edit_file", path, 5, &none()).unwrap();
        assert_eq!(edit.result.map(|r| (r.count, r.line)), Some((1, 3)));
        // Stream step unknown to the transcript: no positional guess.
        let (_, edit) = find_edit(home.path(), CONV, "edit_file", path, 99, &none()).unwrap();
        assert_eq!(edit.result, None);
        // The result row is somewhere else entirely: no result.
        let home = home_with(&[("transcript_full.jsonl", &edit_rows(9, MADE))]);
        let (_, edit) = find_edit(home.path(), CONV, "edit_file", path, 5, &none()).unwrap();
        assert_eq!(edit.result, None);
    }

    #[test]
    fn find_edit_ignores_a_result_row_for_another_path_or_garbage() {
        let other = MADE.replace("a.txt", "b.txt");
        for content in [other.as_str(), "Created file.", "Made 1 replacement"] {
            let home = home_with(&[("transcript_full.jsonl", &edit_rows(5, content))]);
            let (_, edit) =
                find_edit(home.path(), CONV, "edit_file", "/tmp/x/a.txt", 5, &none()).unwrap();
            assert_eq!(edit.result, None, "{content:?}");
        }
    }

    #[test]
    fn encoded_short_transcript_result_content_is_decoded() {
        let call = serde_json::json!({
            "step_index": 4,
            "tool_calls": [{"name": "edit_file", "args": {"Path": "\"/tmp/x/a.txt\"", "Target": "\"a\"", "Replacement": "\"b\""}}]
        });
        let encoded = serde_json::to_string(MADE).unwrap();
        let result = serde_json::json!({"step_index": 5, "type": "GENERIC", "content": encoded});
        let home = home_with(&[("transcript.jsonl", &format!("{call}\n{result}\n"))]);
        let (_, edit) =
            find_edit(home.path(), CONV, "edit_file", "/tmp/x/a.txt", 5, &none()).unwrap();
        assert_eq!(edit.result.map(|r| r.line), Some(3));
    }

    fn later_flag(rows: &[&str]) -> bool {
        let home = home_with(&[("transcript_full.jsonl", &rows.join("\n"))]);
        let (_, edit) = find_edit(home.path(), CONV, "edit_file", "/p", 2, &none()).unwrap();
        edit.later_calls
    }

    const EDIT: &str = r#"{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"edit_file","args":{"Path":"/p","Target":"a","Replacement":"b"}}]}"#;

    #[test]
    fn later_calls_detection() {
        // Alone: nothing follows.
        assert!(!later_flag(&[EDIT]));
        // Sibling in the same row.
        let two = r#"{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"edit_file","args":{"Path":"/p","Target":"a","Replacement":"b"}},{"name":"edit_file","args":{"Path":"/p","Target":"c","Replacement":"d"}}]}"#;
        assert!(later_flag(&[two]));
        // Later row with a mutating call.
        let run = r#"{"step_index":3,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"sed -i x"}}]}"#;
        assert!(later_flag(&[EDIT, run]));
        // Later read-only calls are harmless.
        let read = r#"{"step_index":3,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"read_file","args":{"Path":"/p"}},{"name":"view_file","args":{"Path":"/p"}}]}"#;
        assert!(!later_flag(&[EDIT, read]));
        // A truncated later row is unknown, so it counts.
        let cut = r#"{"step_index":3,"type":"PLANNER_RESPONSE","truncated_fields":["tool_calls"],"tool_calls":[]}"#;
        assert!(later_flag(&[EDIT, cut]));
    }

    #[test]
    fn result_row_must_be_generic_and_after_the_call() {
        let generic = r#"{"step_index":2,"type":"GENERIC","content":"Made 2 replacements in /p starting at line 5 (+1/-1 lines)."}"#;
        let chat = r#"{"step_index":2,"type":"PLANNER_RESPONSE","content":"Made 2 replacements in /p starting at line 5"}"#;
        let find = |rows: &[&str], step| {
            let home = home_with(&[("transcript_full.jsonl", &rows.join("\n"))]);
            find_edit(home.path(), CONV, "edit_file", "/p", step, &none())
                .unwrap()
                .1
                .result
        };
        assert_eq!(
            find(&[EDIT, generic], 2),
            Some(EditResult { count: 2, line: 5 })
        );
        assert_eq!(find(&[EDIT, chat], 2), None);
        // Stream step that is not after the planner row: no pairing.
        assert_eq!(find(&[EDIT, generic], 1), None);
    }
}
