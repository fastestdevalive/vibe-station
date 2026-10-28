//! Anchoring: where does a comment's quote live now?
//!
//! A comment stores the quoted text, the text before and after it, which
//! duplicate it was (`occurrence`) and its last known line span. Re-anchoring
//! looks the quote up in a per-surface corpus: all matches are collected, the
//! ones whose surrounding text still agrees win, and among those the one nearest
//! the last known line. No match at all is `outdated` (the stored quote is kept,
//! never fuzzy-matched).
//!
//! The corpus collapses whitespace runs (CRLF and indentation changes do not
//! break an anchor) and remembers which source line every character came from.

use vst_types::review::{
    AnchorReason, AnchorState, CommentSurface, DiffSide, LineSpan, ReviewComment,
};

/// Files over this many bytes are not anchored (`cant_check`, `file_too_large`).
pub const MAX_ANCHOR_BYTES: u64 = 2 * 1024 * 1024;

/// Stop collecting duplicates beyond this many; far past any real file.
const MAX_MATCHES: usize = 10_000;

/// A searchable text with a map from offsets back to source lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Corpus {
    text: String,
    /// `(offset of a line's first character in text, source line number)`.
    starts: Vec<(usize, u32)>,
    last_line: u32,
}

impl Corpus {
    /// Build from `(line number, text)` pairs (lines may skip numbers: the
    /// old side of a diff, rendered markdown).
    pub fn from_lines<'a>(lines: impl IntoIterator<Item = (u32, &'a str)>) -> Corpus {
        let mut c = Corpus::default();
        let mut pending_space = false;
        for (no, line) in lines {
            c.last_line = c.last_line.max(no);
            let mut first = true;
            for ch in line.chars() {
                if ch.is_whitespace() {
                    pending_space = !c.text.is_empty();
                    continue;
                }
                if pending_space {
                    c.text.push(' ');
                    pending_space = false;
                }
                if first {
                    c.starts.push((c.text.len(), no));
                    first = false;
                }
                c.text.push(ch);
            }
            // The line break is whitespace too.
            pending_space = !c.text.is_empty();
        }
        c
    }

    /// Build from file text (LF, CRLF or lone CR line breaks).
    pub fn from_text(text: &str) -> Corpus {
        let unified = text.replace("\r\n", "\n").replace('\r', "\n");
        Corpus::from_lines(
            unified
                .split('\n')
                .enumerate()
                .map(|(i, l)| (u32::try_from(i + 1).unwrap_or(u32::MAX), l)),
        )
    }

    /// The highest source line number seen.
    pub fn last_line(&self) -> u32 {
        self.last_line
    }

    fn line_at(&self, offset: usize) -> u32 {
        let idx = self.starts.partition_point(|(o, _)| *o <= offset);
        idx.checked_sub(1)
            .and_then(|i| self.starts.get(i))
            .map_or(1, |(_, l)| *l)
    }
}

/// Collapse a quote / prefix / suffix the way the corpus is collapsed.
pub fn normalize(s: &str) -> String {
    Corpus::from_lines([(1, s.replace(['\r', '\n'], " ").as_str())]).text
}

/// What to look for.
#[derive(Clone, Copy, Debug)]
pub struct Probe<'a> {
    pub quote: &'a str,
    pub prefix: &'a str,
    pub suffix: &'a str,
    /// Index of this match among duplicates when the comment was made.
    pub occurrence: u32,
    /// Last known first line (side-relative), the "nearest" reference.
    pub hint: Option<u32>,
}

/// Find the quote; `None` when it occurs nowhere (or the quote is blank).
pub fn locate(corpus: &Corpus, p: &Probe<'_>) -> Option<LineSpan> {
    let quote = normalize(p.quote);
    if quote.is_empty() {
        return None;
    }
    let (prefix, suffix) = (normalize(p.prefix), normalize(p.suffix));
    let hay = corpus.text.as_str();
    let mut matches: Vec<usize> = Vec::new();
    let mut from = 0;
    while let Some(rel) = hay[from..].find(&quote) {
        let off = from + rel;
        matches.push(off);
        if matches.len() >= MAX_MATCHES {
            break;
        }
        from = off + hay[off..].chars().next().map_or(1, char::len_utf8);
    }
    let best = matches
        .iter()
        .enumerate()
        .map(|(idx, &off)| {
            let before_ok = prefix.is_empty() || hay[..off].trim_end().ends_with(prefix.as_str());
            let after_ok = suffix.is_empty()
                || hay[off + quote.len()..]
                    .trim_start()
                    .starts_with(suffix.as_str());
            let agree = u8::from(before_ok) + u8::from(after_ok);
            let line = corpus.line_at(off);
            let distance = match p.hint {
                Some(h) => u64::from(line.abs_diff(h)),
                None => u64::try_from(idx)
                    .unwrap_or(u64::MAX)
                    .abs_diff(u64::from(p.occurrence)),
            };
            (std::cmp::Reverse(agree), distance, idx, off)
        })
        .min()?;
    let off = best.3;
    Some(LineSpan {
        start: corpus.line_at(off),
        end: corpus.line_at(off + quote.len() - 1),
    })
}

/// The anchor result for one comment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub anchor: AnchorState,
    pub reason: Option<AnchorReason>,
    /// The re-anchored span when it differs from the stored one.
    pub current: Option<LineSpan>,
}

impl Outcome {
    pub fn file_missing() -> Self {
        Outcome {
            anchor: AnchorState::FileMissing,
            reason: None,
            current: None,
        }
    }

    pub fn cant_check(reason: AnchorReason) -> Self {
        Outcome {
            anchor: AnchorState::CantCheck,
            reason: Some(reason),
            current: None,
        }
    }

    pub fn outdated() -> Self {
        Outcome {
            anchor: AnchorState::Outdated,
            reason: None,
            current: None,
        }
    }
}

/// The span the comment was made on, in the coordinates of its surface (old or
/// new side for a diff, source lines otherwise).
pub fn stored_span(c: &ReviewComment) -> Option<LineSpan> {
    let (start, end) = match (c.surface, c.side) {
        (CommentSurface::Diff, Some(DiffSide::Old)) => (c.old_start, c.old_end),
        (CommentSurface::Diff, Some(DiffSide::New)) => (c.new_start, c.new_end),
        (CommentSurface::Diff, None) => (None, None),
        _ => (c.line_start, c.line_end),
    };
    let start = start?;
    Some(LineSpan {
        start,
        end: end.unwrap_or(start),
    })
}

/// Anchor `c` against `corpus`.
pub fn anchor_comment(c: &ReviewComment, corpus: &Corpus) -> Outcome {
    let stored = stored_span(c);
    if normalize(&c.quote).is_empty() {
        // A line-only comment has no text to verify: it holds while the line exists.
        return match stored {
            Some(s) if s.end > corpus.last_line() => Outcome::outdated(),
            _ => Outcome {
                anchor: AnchorState::Anchored,
                reason: None,
                current: None,
            },
        };
    }
    let probe = Probe {
        quote: &c.quote,
        prefix: &c.prefix,
        suffix: &c.suffix,
        occurrence: c.occurrence,
        hint: stored.map(|s| s.start),
    };
    match locate(corpus, &probe) {
        Some(span) => Outcome {
            anchor: AnchorState::Anchored,
            reason: None,
            current: (Some(span) != stored).then_some(span),
        },
        None => Outcome::outdated(),
    }
}

/// The old side of a unified diff as `(old line number, text)`: removed and
/// context rows, which is what a comment on the old side of a diff quotes.
pub fn old_side_lines(diff: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut old_line = 0u32;
    let mut in_hunk = false;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("@@ -") {
            let start = rest
                .split([',', ' '])
                .next()
                .and_then(|n| n.parse::<u32>().ok());
            match start {
                Some(s) => {
                    old_line = s;
                    in_hunk = true;
                }
                None => in_hunk = false,
            }
            continue;
        }
        if !in_hunk {
            continue;
        }
        match line.chars().next() {
            Some('-') => {
                out.push((old_line, line[1..].to_string()));
                old_line += 1;
            }
            Some(' ') => {
                out.push((old_line, line[1..].to_string()));
                old_line += 1;
            }
            // Added rows have no old line; `\ No newline at end of file` is a marker.
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe<'a>(quote: &'a str, prefix: &'a str, suffix: &'a str, hint: Option<u32>) -> Probe<'a> {
        Probe {
            quote,
            prefix,
            suffix,
            occurrence: 0,
            hint,
        }
    }

    #[test]
    fn crlf_and_indentation_do_not_break_an_anchor() {
        let unix = Corpus::from_text("fn main() {\n    let x = 1;\n}\n");
        let dos = Corpus::from_text("fn main() {\r\n\tlet   x = 1;\r\n}\r\n");
        let p = probe("let x = 1;", "", "", None);
        let want = Some(LineSpan { start: 2, end: 2 });
        assert_eq!(locate(&unix, &p), want);
        assert_eq!(locate(&dos, &p), want);
        // The quote itself may carry other whitespace than the file.
        assert_eq!(
            locate(&unix, &probe("let\n  x   =\t1;", "", "", None)),
            want
        );
    }

    #[test]
    fn multi_line_quote_spans_its_lines() {
        let c = Corpus::from_text("a\nfoo bar\nbaz qux\nz\n");
        assert_eq!(
            locate(&c, &probe("foo bar\nbaz qux", "", "", None)),
            Some(LineSpan { start: 2, end: 3 })
        );
    }

    #[test]
    fn duplicates_pick_the_one_whose_context_agrees() {
        let src = "return a;\nx\nreturn a;\ny\nreturn a;\n";
        let c = Corpus::from_text(src);
        // Context says: preceded by "y", so the third one even though the hint is line 1.
        let p = probe("return a;", "y", "", Some(1));
        assert_eq!(locate(&c, &p), Some(LineSpan { start: 5, end: 5 }));
        // Followed by "y": the second.
        let p = probe("return a;", "", "y", Some(5));
        assert_eq!(locate(&c, &p), Some(LineSpan { start: 3, end: 3 }));
    }

    #[test]
    fn without_context_the_nearest_to_the_last_known_line_wins() {
        let c = Corpus::from_text("dup\nq\nq\ndup\nq\nq\ndup\n");
        assert_eq!(
            locate(&c, &probe("dup", "", "", Some(5))),
            Some(LineSpan { start: 4, end: 4 })
        );
        assert_eq!(
            locate(&c, &probe("dup", "", "", Some(100))),
            Some(LineSpan { start: 7, end: 7 })
        );
        // No hint: the recorded occurrence index decides.
        let mut p = probe("dup", "", "", None);
        p.occurrence = 1;
        assert_eq!(locate(&c, &p), Some(LineSpan { start: 4, end: 4 }));
    }

    #[test]
    fn a_missing_quote_is_not_found_and_a_blank_quote_never_matches() {
        let c = Corpus::from_text("alpha\nbeta\n");
        assert_eq!(locate(&c, &probe("gamma", "", "", None)), None);
        assert_eq!(locate(&c, &probe("  \n ", "", "", None)), None);
    }

    #[test]
    fn unicode_quotes_locate_without_slicing_inside_a_char() {
        let c = Corpus::from_text("héllo wörld\nnaïve café\n");
        assert_eq!(
            locate(&c, &probe("café", "naïve", "", None)),
            Some(LineSpan { start: 2, end: 2 })
        );
    }

    fn comment(quote: &str, line: u32) -> ReviewComment {
        ReviewComment {
            id: "c".into(),
            scope_kind: vst_types::artifacts::ScopeKind::Worktree,
            scope_id: "wt".into(),
            pin: 1,
            path: "a.rs".into(),
            path_kind: vst_types::review::PathKind::Repo,
            surface: CommentSurface::File,
            diff_scope: None,
            base_sha: None,
            side: None,
            line_start: Some(line),
            line_end: Some(line),
            old_start: None,
            old_end: None,
            new_start: None,
            new_end: None,
            quote: quote.into(),
            prefix: String::new(),
            suffix: String::new(),
            occurrence: 0,
            text: "t".into(),
            anchor: AnchorState::Anchored,
            anchor_reason: None,
            current: None,
            moved_from: None,
            attached_to: None,
            restored_reason: None,
            block_bytes: 0,
            version: 1,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn anchor_comment_reports_a_moved_span_only_when_it_moved() {
        let stays = anchor_comment(&comment("beta", 2), &Corpus::from_text("alpha\nbeta\n"));
        assert_eq!(stays.anchor, AnchorState::Anchored);
        assert_eq!(stays.current, None);
        let moved = anchor_comment(
            &comment("beta", 2),
            &Corpus::from_text("new\nnew\nalpha\nbeta\n"),
        );
        assert_eq!(moved.anchor, AnchorState::Anchored);
        assert_eq!(moved.current, Some(LineSpan { start: 4, end: 4 }));
        let gone = anchor_comment(&comment("beta", 2), &Corpus::from_text("alpha\ngamma\n"));
        assert_eq!(gone, Outcome::outdated());
    }

    #[test]
    fn a_line_only_comment_holds_while_its_line_exists() {
        let c = comment("", 3);
        assert_eq!(
            anchor_comment(&c, &Corpus::from_text("a\nb\nc\n")).anchor,
            AnchorState::Anchored
        );
        assert_eq!(
            anchor_comment(&c, &Corpus::from_text("a\n")).anchor,
            AnchorState::Outdated
        );
    }

    #[test]
    fn old_side_of_a_fixture_diff_uses_old_line_numbers() {
        let diff = "\
diff --git a/f.rs b/f.rs
index 111..222 100644
--- a/f.rs
+++ b/f.rs
@@ -10,5 +10,5 @@ fn ctx()
 keep one
-removed line A
-removed line B
+added line
 keep two
 keep three
@@ -40,3 +39,2 @@
 tail
-gone tail
 end
";
        let rows = old_side_lines(diff);
        let get = |n: u32| rows.iter().find(|(l, _)| *l == n).map(|(_, t)| t.as_str());
        assert_eq!(get(10), Some("keep one"));
        assert_eq!(get(11), Some("removed line A"));
        assert_eq!(get(12), Some("removed line B"));
        assert_eq!(get(13), Some("keep two"));
        assert_eq!(get(41), Some("gone tail"));
        assert!(!rows.iter().any(|(_, t)| t == "added line"));
        // A comment on the old side finds its removed line at the OLD number.
        let corpus = Corpus::from_lines(rows.iter().map(|(n, t)| (*n, t.as_str())));
        assert_eq!(
            locate(&corpus, &probe("removed line B", "", "", Some(1))),
            Some(LineSpan { start: 12, end: 12 })
        );
        // `+++ b/f.rs` / `--- a/f.rs` headers are not rows.
        assert!(!rows
            .iter()
            .any(|(_, t)| t.contains("a/f.rs") || t.contains("b/f.rs")));
    }

    #[test]
    fn markdown_corpus_matches_rendered_text() {
        use crate::md_plain::md_plain_lines;
        let src = "# Title\n\nSome **bold** text with a [link](http://x.y).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let lines = md_plain_lines(src);
        let corpus = Corpus::from_lines(lines.iter().map(|(n, t)| (*n, t.as_str())));
        assert_eq!(
            locate(&corpus, &probe("Some bold text with a link.", "", "", None)),
            Some(LineSpan { start: 3, end: 3 })
        );
        assert_eq!(
            locate(&corpus, &probe("a b 1 2", "", "", None)),
            Some(LineSpan { start: 5, end: 7 })
        );
    }
}
