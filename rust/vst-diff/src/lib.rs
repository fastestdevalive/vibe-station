#![forbid(unsafe_code)]
//! `vst-diff` — server-side trimming of whole-file edit diffs into hunks.
//!
//! Some ACP agents (opencode v2) send a `{type:"diff"}` tool-call content entry
//! whose `oldText`/`newText` are the WHOLE file on both sides of an edit. That
//! renders as one enormous hunk in Rich Chat and triples the persisted bytes for
//! every edit. [`trim_tool_diffs`] turns such a diff into one [`ToolDiff`] per
//! changed region (each with its own 1-based `old_start`/`new_start` in the
//! ORIGINAL files), keeping [`CONTEXT_LINES`] unchanged lines around each region.
//!
//! The trim is content-based, not per-CLI: a plugin that already sends small
//! snippets (claude) never crosses [`MIN_TRIM_BYTES`] and passes through
//! untouched. Every ambiguity resolves toward "keep the original" — an untrimmed
//! diff is merely verbose, while a wrongly sliced one is wrong:
//!
//! - `old_text` absent/empty (a Write / new file) — nothing to trim against
//! - `old == new`, NUL bytes, bare-`\r` line endings, sub-[`MIN_TRIM_BYTES`],
//!   over-[`MAX_TRIM_BYTES`]
//! - already-trimmed (`old_start`/`new_start` present) — idempotency
//! - the diff engine misses [`DEADLINE`], or its groups cover the whole file
//!   (no unchanged run was actually beyond the context)
//!
//! Pure function: no I/O, no state. `vst-agents` calls it while normalizing a
//! tool event and `vst-store` calls it from the transcript backfill/import, which
//! is why it lives in its own crate rather than inside either one.

use std::time::{Duration, Instant};

use similar::{DiffOp, TextDiff};
use vst_types::ToolDiff;

/// Unchanged lines kept on each side of a hunk.
pub const CONTEXT_LINES: usize = 3;

/// Below this (the larger of `oldText`/`newText`), a diff is presumed to be a
/// legit small snippet and is never touched.
pub const MIN_TRIM_BYTES: usize = 2 * 1024;

/// Above this on EITHER side, skip diffing entirely — the cost is unbounded
/// and the payoff is a diff nobody can read anyway. Applied per side (not to
/// the sum) so a one-line edit to a ~1 MB file still trims: the diff itself is
/// trivial there, and the combined-size reading silently left every such file
/// as an unreadable whole-file diff (then `(diff omitted — N bytes)` after the
/// 20 KB cap).
pub const MAX_TRIM_BYTES: usize = 2 * 1024 * 1024;

/// Wall-clock budget for one diff. On expiry the original is kept.
///
/// Worst case this is inline work on the caller's thread, and the same edit
/// normally reaches [`trim_tool_diffs`] twice (the `tool_call` and its
/// `tool_call_update`), so ~2×[`DEADLINE`] is the practical ceiling per edit.
/// The deadline is wall-clock, hence load-sensitive: a pathological payload can
/// trim on one copy and fall back on the other. That is accepted — the fallback
/// is merely verbose, and the alternative (a shared per-tool-id cache) would
/// put state inside a pure function.
pub const DEADLINE: Duration = Duration::from_millis(200);

/// Rewrite every whole-file diff in `diffs` into one diff per changed hunk.
///
/// Mutates `diffs` in place (a single input diff may become several) and
/// returns `true` when anything changed, so callers can skip a pointless write.
pub fn trim_tool_diffs(diffs: &mut Vec<ToolDiff>) -> bool {
    let mut changed = false;
    let mut out: Vec<ToolDiff> = Vec::with_capacity(diffs.len());
    for diff in std::mem::take(diffs) {
        match trim_one(&diff) {
            Some(hunks) => {
                changed = true;
                out.extend(hunks);
            }
            None => out.push(diff),
        }
    }
    *diffs = out;
    changed
}

/// `Some(hunks)` when this diff was trimmed, `None` to keep it byte-identical.
fn trim_one(diff: &ToolDiff) -> Option<Vec<ToolDiff>> {
    // Already trimmed — never re-diff a hunk (it would renumber its starts).
    if diff.old_start.is_some() || diff.new_start.is_some() {
        return None;
    }
    let old = diff.old_text.as_deref()?;
    if old.is_empty() || old == diff.new_text {
        return None;
    }
    if old.len().max(diff.new_text.len()) < MIN_TRIM_BYTES {
        return None;
    }
    if old.len() > MAX_TRIM_BYTES || diff.new_text.len() > MAX_TRIM_BYTES {
        return None;
    }
    if has_nul(old) || has_nul(&diff.new_text) || has_bare_cr(old) || has_bare_cr(&diff.new_text) {
        return None;
    }

    let started = Instant::now();
    let diffed = TextDiff::configure()
        .timeout(DEADLINE)
        .diff_lines(old, &diff.new_text);
    let groups = diffed.grouped_ops(CONTEXT_LINES);
    // `similar` answers a deadline with a valid-but-possibly-coarser diff; a
    // wrong hunk boundary is worse than a verbose one, so fall back.
    if started.elapsed() > DEADLINE {
        return None;
    }
    if groups.is_empty() {
        return None;
    }

    let old_lines = split_keep_ends(old);
    let new_lines = split_keep_ends(&diff.new_text);
    // Nothing was dropped: the groups jointly cover both files end to end, so
    // keep the original text instead of re-emitting it line by line.
    if groups.len() == 1 {
        let (old_range, new_range) = group_ranges(&groups[0])?;
        if old_range.start == 0
            && old_range.end == old_lines.len()
            && new_range.start == 0
            && new_range.end == new_lines.len()
        {
            return None;
        }
    }

    let mut hunks = Vec::with_capacity(groups.len());
    for group in &groups {
        let (old_range, new_range) = group_ranges(group)?;
        // Line ranges always land on line boundaries in the ORIGINAL texts, so
        // slicing the two originals keeps every byte (incl. `\r\n` and the
        // absence of a final newline) exactly as the file had it.
        let old_text = old_lines.get(old_range.clone())?.concat();
        let new_text = new_lines.get(new_range.clone())?.concat();
        hunks.push(ToolDiff {
            path: diff.path.clone(),
            old_text: Some(old_text),
            new_text,
            old_start: Some(to_u32(old_range.start)),
            new_start: Some(to_u32(new_range.start)),
        });
    }
    Some(hunks)
}

/// 0-based range start → 1-based line number, saturating instead of wrapping.
fn to_u32(zero_based: usize) -> u32 {
    u32::try_from(zero_based.saturating_add(1)).unwrap_or(u32::MAX)
}

/// The union of a group's ops: the old/new line ranges it covers.
fn group_ranges(group: &[DiffOp]) -> Option<(std::ops::Range<usize>, std::ops::Range<usize>)> {
    let first = group.first()?;
    let last = group.last()?;
    let old_start = first.old_range().start;
    let new_start = first.new_range().start;
    Some((
        old_start..last.old_range().end,
        new_start..last.new_range().end,
    ))
}

/// Split into lines that KEEP their terminator, so `concat()` reproduces the
/// input byte-for-byte. Only `\n` ends a line here (a `\r\n` stays attached),
/// which is the same line model the web UI's diff renderer uses.
fn split_keep_ends(s: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            lines.push(&s[start..=i]);
            start = i + 1;
        }
    }
    if start < s.len() {
        lines.push(&s[start..]);
    }
    lines
}

fn has_nul(s: &str) -> bool {
    s.as_bytes().contains(&0)
}

/// True when `s` contains a `\r` that is not part of a `\r\n` pair. `similar`
/// treats such a byte as a line break while the UI's renderer does not, so
/// trimming one would make the gutter disagree with `old_start`/`new_start`.
fn has_bare_cr(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(i, b)| *b == b'\r' && bytes.get(i + 1) != Some(&b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One ~58-byte line, so 40 lines comfortably clear `MIN_TRIM_BYTES`.
    fn line(tag: &str, i: usize) -> String {
        format!("{tag} line {i:03} ........................................\n")
    }

    fn lines(n: usize, tag: &str) -> String {
        (1..=n).map(|i| line(tag, i)).collect()
    }

    fn diff(old: Option<String>, new: String) -> ToolDiff {
        ToolDiff {
            path: "/tmp/f.rs".to_string(),
            old_text: old,
            new_text: new,
            old_start: None,
            new_start: None,
        }
    }

    /// A 40-line file with one changed line — the report's Bug 1 shape.
    #[test]
    fn single_edit_in_large_file_becomes_one_hunk_with_its_real_line_number() {
        let old = lines(40, "before");
        let new = old.replace(&line("before", 20), &line("after", 20));
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs));

        assert_eq!(diffs.len(), 1, "one changed region => one hunk");
        let h = &diffs[0];
        assert_eq!(h.old_start, Some(17), "3 context lines above line 20");
        assert_eq!(h.new_start, Some(17));
        let expected_old: String = (17..=23).map(|i| line("before", i)).collect();
        assert_eq!(h.old_text.as_deref(), Some(expected_old.as_str()));
        assert!(h.new_text.contains(&line("after", 20)));
        assert!(
            !h.new_text.contains(&line("before", 1)),
            "untouched head dropped"
        );
        assert!(!h.new_text.contains(&line("before", 40)));
    }

    #[test]
    fn two_hunks_keep_independent_old_and_new_starts_after_an_insertion() {
        let old = lines(60, "x");
        let new = format!(
            "NEW A\nNEW B\n{}",
            old.replace(&line("x", 40), &line("CHANGED", 40))
        );
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs));

        assert_eq!(diffs.len(), 2);
        // Hunk 1: the two added lines at the top (plus 3 context).
        assert_eq!(diffs[0].old_start, Some(1));
        assert_eq!(diffs[0].new_start, Some(1));
        let expected_first: String = std::iter::once("NEW A\nNEW B\n".to_string())
            .chain((1..=3).map(|i| line("x", i)))
            .collect();
        assert_eq!(diffs[0].new_text, expected_first);
        // The insertion shifts everything after it by two lines.
        assert_eq!(diffs[1].old_start, Some(37));
        assert_eq!(diffs[1].new_start, Some(39));
    }

    #[test]
    fn crlf_is_preserved_byte_for_byte() {
        let crlf = |i: usize| format!("l{i:03} ........................................\r\n");
        let old: String = (1..=60).map(crlf).collect();
        let new = old.replace(
            &crlf(20),
            "l020 CHANGED ................................\r\n",
        );
        let mut diffs = vec![diff(Some(old.clone()), new)];
        assert!(trim_tool_diffs(&mut diffs));
        let h = &diffs[0];
        assert_eq!(h.old_start, Some(17));
        assert!(h.new_text.contains("\r\n"));
        assert!(!h.new_text.contains(&crlf(1)));
        // Slicing must round-trip the CRLF bytes exactly.
        let old_lines = split_keep_ends(&old);
        assert_eq!(old_lines[19], crlf(20));
        assert_eq!(old_lines[19].len(), crlf(20).len());
    }

    #[test]
    fn missing_final_newline_is_preserved() {
        let old = format!("{}tail", lines(40, "x"));
        let new = old.replace("tail", "tail changed");
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs));
        let h = &diffs[0];
        assert!(h.old_text.as_deref().unwrap().ends_with("tail"));
        assert!(!h.new_text.ends_with('\n'), "no invented trailing newline");
        assert_eq!(h.old_start, Some(38));
        assert_eq!(h.new_start, Some(38));
    }

    #[test]
    fn bare_cr_passes_through() {
        let old = format!("a\rb\rc\r{}", lines(40, "x"));
        let new = old.replace("c\r", "c changed\r");
        let mut diffs = vec![diff(Some(old.clone()), new)];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_text.as_deref(), Some(old.as_str()));
        assert_eq!(diffs[0].old_start, None);
    }

    #[test]
    fn identical_texts_pass_through() {
        let text = lines(40, "same");
        let mut diffs = vec![diff(Some(text.clone()), text.clone())];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].old_start, None);
        assert_eq!(diffs[0].old_text.as_deref(), Some(text.as_str()));
    }

    #[test]
    fn nul_bytes_pass_through() {
        let old = format!("{}a\0b\n", lines(40, "x"));
        let new = old.replace("a\0b", "a\0c");
        let mut diffs = vec![diff(Some(old), new)];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_start, None);
    }

    #[test]
    fn write_new_file_passes_through() {
        let mut diffs = vec![diff(Some(String::new()), lines(100, "new"))];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_start, None);
        let mut diffs = vec![diff(None, lines(100, "new"))];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_start, None);
    }

    #[test]
    fn small_snippets_pass_through() {
        let old = "one\ntwo\nthree\n".to_string();
        let new = "one\nTWO\nthree\n".to_string();
        let mut diffs = vec![diff(Some(old.clone()), new)];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_text.as_deref(), Some(old.as_str()));
    }

    #[test]
    fn oversized_inputs_pass_through() {
        let mut old = lines(2000, "a padded line to make the file big");
        while old.len() <= MAX_TRIM_BYTES {
            old.push_str("a padded line to make the file big\n");
        }
        let new = format!("{old}extra\n");
        let mut diffs = vec![diff(Some(old.clone()), new)];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_text.as_deref(), Some(old.as_str()));
        assert_eq!(diffs[0].new_start, None);
    }

    /// The limit is per side, so a file just over the OLD combined limit
    /// (~1 MB) still trims a one-line edit. Under the combined reading this
    /// whole class passed through and the 20 KB cap then turned it into
    /// `(diff omitted — N bytes)` — the original bad-file symptom, unfixed.
    #[test]
    fn one_megabyte_file_still_trims() {
        let old = lines(20_000, "big");
        assert!(
            old.len() > 1024 * 1024 && old.len() < MAX_TRIM_BYTES,
            "test fixture must sit in the old combined-limit dead zone"
        );
        let new = old.replace(&line("big", 10_000), &line("CHANGED", 10_000));
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs), "must trim, not fall back");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].old_start, Some(9_997));
        assert_eq!(diffs[0].new_start, Some(9_997));
        assert!(diffs[0].new_text.len() < 1024);
        assert!(diffs[0].new_text.contains(&line("CHANGED", 10_000)));
    }

    #[test]
    fn all_changed_passes_through_unchanged() {
        let old = lines(80, "old");
        let new = lines(80, "new");
        let mut diffs = vec![diff(Some(old.clone()), new)];
        assert!(!trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_text.as_deref(), Some(old.as_str()));
    }

    /// Second pass over already-trimmed output must be a byte-identical no-op,
    /// starts included (a re-diff would renumber them from 1).
    #[test]
    fn second_pass_is_idempotent_and_keeps_starts() {
        let old = lines(80, "x");
        let new = old
            .replace(&line("x", 20), &line("y", 20))
            .replace(&line("x", 60), &line("y", 60));
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs));
        let first = diffs.clone();
        assert_eq!(first.len(), 2);
        assert!(!trim_tool_diffs(&mut diffs), "nothing left to trim");
        assert_eq!(diffs, first);
    }

    #[test]
    fn several_diffs_are_trimmed_independently() {
        let old_a = lines(50, "a");
        let new_a = old_a.replace(&line("a", 10), &line("A", 10));
        let combined = format!("{}{}", lines(60, "b"), lines(40, "short"));
        let new_b = combined.replace(&line("b", 50), &line("B", 50));
        let mut diffs = vec![
            diff(Some(old_a), new_a),
            diff(Some(combined), new_b),
            diff(Some("tiny\n".into()), "tiny changed\n".into()),
        ];
        assert!(trim_tool_diffs(&mut diffs));
        assert_eq!(
            diffs.len(),
            3,
            "two 1-hunk diffs plus the untouched tiny one"
        );
        assert_eq!(diffs[0].old_start, Some(7));
        assert_eq!(diffs[1].old_start, Some(47));
        assert_eq!(diffs[2].old_start, None);
    }

    #[test]
    fn old_start_and_new_start_are_one_based_line_numbers() {
        // Edit on the very first line: no room for leading context.
        let old = lines(40, "x");
        let new = old.replace(&line("x", 1), "FIRST\n");
        let mut diffs = vec![diff(Some(old), new)];
        assert!(trim_tool_diffs(&mut diffs));
        assert_eq!(diffs[0].old_start, Some(1));
        assert_eq!(diffs[0].new_start, Some(1));
    }
}
