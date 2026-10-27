//! Turns a resolved [`FileEdit`] into the diff pieces shown to the user, each
//! with the REAL 1-based line numbers of the file (never a guess).
//!
//! agy's `edit_file` replaces EVERY occurrence of `Target` in one call, and
//! its transcript result row reports how many replacements it made and the
//! line of the first (see [`transcript::parse_edit_result`]). From that:
//!
//! - one replacement: one piece at that line (same line in old and new file);
//! - N > 1 and a non-empty `Replacement`: find the N non-overlapping
//!   occurrences of `Replacement` in the current file, scanning from the start
//!   of the reported line. Exactly N found (and the first on the reported
//!   line): one piece per occurrence, with old-file lines derived by undoing
//!   the line shift of earlier replacements. Otherwise only the first
//!   replacement is shown (its line is known);
//! - no usable result row: only if `Replacement` occurs exactly once in the
//!   current file is that line used; otherwise NO piece (a card without a diff
//!   beats a diff with wrong numbers).
//!
//! Later-call guard: when agy issued any other (non-read) tool call after this
//! one - several calls in one response, or later rows - the file on disk may
//! already contain THAT call's changes, so it is never read: one replacement
//! uses the reported line (exact, agy reports it at the time of the edit),
//! N > 1 shows only the first replacement at the reported line (exact), and no
//! result row means no diff. The same fallback applies if the transcript grew
//! while the file was being read.
//!
//! `write_file` is a whole new file starting at line 1: one piece, no starts.

use std::fs::File;
use std::io::Read;

use crate::transcript::{self, EditResult, FileEdit};

/// One diff to emit. `starts` = (old, new), 1-based; `None` = whole-file diff
/// that needs no explicit position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffPiece {
    pub old_text: Option<String>,
    pub new_text: String,
    pub starts: Option<(u32, u32)>,
}

/// Pieces for `edit`; empty when no trustworthy line number exists.
#[must_use]
pub fn plan(edit: &FileEdit) -> Vec<DiffPiece> {
    let Some(target) = edit.old_text.as_deref() else {
        return vec![DiffPiece {
            old_text: None,
            new_text: edit.new_text.clone(),
            starts: None,
        }];
    };
    if target.is_empty() {
        return Vec::new();
    }
    let repl = edit.new_text.as_str();
    let piece = |line: usize| {
        let line = u32::try_from(line).ok()?;
        Some(DiffPiece {
            old_text: Some(target.to_string()),
            new_text: repl.to_string(),
            starts: Some((line, line)),
        })
    };
    // Reading the file is only sound while nothing can have changed it after
    // this call; `stable()` re-checks that after the read.
    let readable = !edit.later_calls;
    let stable = || {
        edit.source
            .as_ref()
            .map_or(true, |s| !transcript::transcript_grew(s))
    };
    match edit.result {
        Some(EditResult { count: 1, line }) => piece(line).into_iter().collect(),
        Some(EditResult { count, line }) => {
            if readable {
                if let Some(pieces) = multi(&edit.path, target, repl, count, line, &stable) {
                    return pieces;
                }
            }
            piece(line).into_iter().collect()
        }
        None if readable => unique_line(&edit.path, repl, &stable)
            .and_then(piece)
            .into_iter()
            .collect(),
        None => Vec::new(),
    }
}

/// N pieces for N replacements, or `None` when they cannot be located exactly.
fn multi(
    path: &str,
    target: &str,
    repl: &str,
    count: usize,
    line: usize,
    stable: &dyn Fn() -> bool,
) -> Option<Vec<DiffPiece>> {
    if repl.is_empty() {
        return None;
    }
    let file = read_current(path)?;
    if !stable() {
        return None;
    }
    let from = line_offset(&file, line)?;
    let offsets: Vec<usize> = file[from..]
        .match_indices(repl)
        .map(|(at, _)| from + at)
        .collect();
    if offsets.len() != count {
        return None;
    }
    let shift = i64::try_from(repl.matches('\n').count()).ok()?
        - i64::try_from(target.matches('\n').count()).ok()?;
    let mut pieces = Vec::with_capacity(count);
    for (k, at) in offsets.iter().enumerate() {
        let new_line = 1 + file[..*at].matches('\n').count();
        if k == 0 && new_line != line {
            return None;
        }
        let old_line = i64::try_from(new_line).ok()? - shift * i64::try_from(k).ok()?;
        if old_line < 1 {
            return None;
        }
        pieces.push(DiffPiece {
            old_text: Some(target.to_string()),
            new_text: repl.to_string(),
            starts: Some((u32::try_from(old_line).ok()?, u32::try_from(new_line).ok()?)),
        });
    }
    Some(pieces)
}

/// 1-based line of `repl` when it occurs exactly once in the current file.
fn unique_line(path: &str, repl: &str, stable: &dyn Fn() -> bool) -> Option<usize> {
    if repl.is_empty() {
        return None;
    }
    let file = read_current(path)?;
    if !stable() {
        return None;
    }
    let mut found = file.match_indices(repl);
    let (at, _) = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(1 + file[..at].matches('\n').count())
}

/// Byte offset where 1-based `line` starts.
fn line_offset(text: &str, line: usize) -> Option<usize> {
    if line == 1 {
        return Some(0);
    }
    text.match_indices('\n')
        .nth(line.checked_sub(2)?)
        .map(|(at, _)| at + 1)
}

/// The file as it is now; regular, UTF-8, within the transcript size cap.
fn read_current(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > transcript::MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(transcript::MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(path: &str, target: &str, repl: &str, result: Option<(usize, usize)>) -> FileEdit {
        FileEdit {
            path: path.to_string(),
            old_text: Some(target.to_string()),
            new_text: repl.to_string(),
            result: result.map(|(count, line)| EditResult { count, line }),
            later_calls: false,
            source: None,
        }
    }

    fn file(body: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, body).unwrap();
        let path = path.to_string_lossy().into_owned();
        (dir, path)
    }

    fn starts(pieces: &[DiffPiece]) -> Vec<Option<(u32, u32)>> {
        pieces.iter().map(|p| p.starts).collect()
    }

    #[test]
    fn write_file_is_one_piece_without_starts() {
        let write = FileEdit {
            path: "/x".into(),
            old_text: None,
            new_text: "hi".into(),
            result: None,
            later_calls: false,
            source: None,
        };
        let pieces = plan(&write);
        assert_eq!(starts(&pieces), [None]);
        assert_eq!(pieces[0].old_text, None);
    }

    #[test]
    fn single_replacement_uses_the_reported_line_without_reading_the_file() {
        let pieces = plan(&edit("/does/not/exist", "a\nb", "A", Some((1, 3))));
        assert_eq!(starts(&pieces), [Some((3, 3))]);
        assert_eq!(pieces[0].old_text.as_deref(), Some("a\nb"));
        assert_eq!(pieces[0].new_text, "A");
    }

    #[test]
    fn two_single_line_replacements_get_one_piece_each() {
        // dup.txt "l1\nfoo\nl3\nfoo\nl5" with foo -> baz.
        let (_d, path) = file("l1\nbaz\nl3\nbaz\nl5");
        let pieces = plan(&edit(&path, "foo", "baz", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2)), Some((4, 4))]);
    }

    #[test]
    fn multi_line_shift_makes_old_and_new_starts_differ() {
        // Target 1 line -> Replacement 3 lines (+2 each).
        // old: l1 / foo / l3 / foo / l5      new: l1 / A,B,C / l3 / A,B,C / l5
        let (_d, path) = file("l1\nA\nB\nC\nl3\nA\nB\nC\nl5");
        let pieces = plan(&edit(&path, "foo", "A\nB\nC", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2)), Some((4, 6))]);
        // Shrinking: Target 3 lines -> Replacement 1 line (-2 each).
        let (_d, path) = file("l1\nX\nl3\nX\nl5");
        let pieces = plan(&edit(&path, "a\nb\nc", "X", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2)), Some((6, 4))]);
    }

    #[test]
    fn count_mismatch_or_empty_replacement_falls_back_to_first_only() {
        // Replacement text also appears later in the file: 3 found, N = 2.
        let (_d, path) = file("x\nbaz\nbaz\nbaz\n");
        let pieces = plan(&edit(&path, "foo", "baz", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
        // Deletion (empty replacement) cannot be located.
        let (_d, path) = file("a\nc\n");
        let pieces = plan(&edit(&path, "b", "", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
        // Unreadable file.
        let pieces = plan(&edit("/does/not/exist", "foo", "baz", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
    }

    #[test]
    fn first_occurrence_must_sit_on_the_reported_line() {
        let (_d, path) = file("x\ny\nbaz\nbaz\n");
        let pieces = plan(&edit(&path, "foo", "baz", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
    }

    #[test]
    fn no_result_row_uses_a_unique_occurrence_only() {
        let (_d, path) = file("l1\nl2\nbaz\nl4\n");
        let pieces = plan(&edit(&path, "foo", "baz", None));
        assert_eq!(starts(&pieces), [Some((3, 3))]);
    }

    #[test]
    fn no_result_row_and_ambiguity_emit_no_diff() {
        let (_d, dup) = file("baz\nx\nbaz\n");
        assert!(plan(&edit(&dup, "foo", "baz", None)).is_empty());
        let (_d, gone) = file("nothing here\n");
        assert!(plan(&edit(&gone, "foo", "baz", None)).is_empty());
        let (_d, del) = file("a\nc\n");
        assert!(plan(&edit(&del, "b", "", None)).is_empty());
        assert!(plan(&edit("/does/not/exist", "foo", "baz", None)).is_empty());
        assert!(plan(&edit(&dup, "", "baz", Some((1, 1)))).is_empty());
    }

    fn later(mut e: FileEdit) -> FileEdit {
        e.later_calls = true;
        e
    }

    #[test]
    fn later_call_never_reads_the_file() {
        // The file already holds a sibling call's changes: 3 occurrences of
        // the replacement look like a clean N = 3 match, yet only the first
        // (exact) replacement may be shown.
        let (_d, path) = file("TO\nKEN\nb\nTO\nKEN\nX\nTO\nKEN\n");
        let pieces = plan(&later(edit(&path, "TOKEN", "TO\nKEN", Some((3, 1)))));
        assert_eq!(starts(&pieces), [Some((1, 1))]);
        // Single replacement: reported line as is.
        let pieces = plan(&later(edit("/does/not/exist", "a", "b", Some((1, 7)))));
        assert_eq!(starts(&pieces), [Some((7, 7))]);
        // No result row: no diff, even for a unique occurrence.
        let (_d, uniq) = file("l1\nbaz\n");
        assert!(plan(&later(edit(&uniq, "foo", "baz", None))).is_empty());
    }

    #[test]
    fn grown_transcript_falls_back_to_the_later_call_behaviour() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("t.jsonl");
        std::fs::write(&log, "a\n").unwrap();
        let (_d, path) = file("l1\nbaz\nl3\nbaz\nl5");
        let mut e = edit(&path, "foo", "baz", Some((2, 2)));
        e.source = Some((log.clone(), 2));
        assert_eq!(starts(&plan(&e)), [Some((2, 2)), Some((4, 4))]);
        e.source = Some((log, 1)); // transcript is longer than when scanned
        assert_eq!(starts(&plan(&e)), [Some((2, 2))]);
    }

    #[test]
    fn same_line_matches_are_located_per_occurrence() {
        // "a a" -> "b b" on one line: both on line 2.
        let (_d, path) = file("x\nb b\ny");
        let pieces = plan(&edit(&path, "a", "b", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2)), Some((2, 2))]);
    }

    #[test]
    fn replacement_containing_target_falls_back_to_first_only() {
        // Target "foo" -> "foofoo", N = 2: a pre-existing extra copy of the
        // replacement text makes 3 matches, so only the first is shown.
        let (_d, path) = file("a\nfoofoo\nfoofoo\nfoofoo\n");
        let pieces = plan(&edit(&path, "foo", "foofoo", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
        // Clean case still resolves.
        let (_d, path) = file("a\nfoofoo\nz\nfoofoo\n");
        let pieces = plan(&edit(&path, "foo", "foofoo", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2)), Some((4, 4))]);
    }

    #[test]
    fn crlf_file_with_lf_target_is_first_only() {
        // Replacement "A\nB" never matches "A\r\nB": count mismatch.
        let (_d, path) = file("x\r\nA\r\nB\r\nA\r\nB\r\n");
        let pieces = plan(&edit(&path, "foo", "A\nB", Some((2, 2))));
        assert_eq!(starts(&pieces), [Some((2, 2))]);
    }

    #[test]
    fn line_offsets() {
        assert_eq!(line_offset("a\nb\nc", 1), Some(0));
        assert_eq!(line_offset("a\nb\nc", 2), Some(2));
        assert_eq!(line_offset("a\nb\nc", 3), Some(4));
        assert_eq!(line_offset("a\nb\nc", 4), None);
        assert_eq!(line_offset("a", 0), None);
    }
}
