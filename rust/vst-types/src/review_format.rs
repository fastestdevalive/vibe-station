//! The one renderer for review comments (PRD Appendix A): Rich Chat appends its
//! output to a turn, Terminal pastes it, Copy as text returns it, and golden
//! fixtures pin it. The web has no renderer, only a tolerant parser for
//! imported history.
//!
//! Safety (R77): every body goes through [`sanitize_review_text`] and is
//! block-indented, so a quote can never forge a `2) File:` item, carry a
//! terminal control sequence, or hide text behind a bidi override.

use crate::review::{DiffScope, DiffSide, ReviewCommentSnapshot};

/// Prefix of every line of a multi-line body (`   | `).
const BODY_PREFIX: &str = "   | ";

/// Shown for a character that must not reach a terminal or hide text: bidi and
/// zero-width characters, soft hyphen, tag characters (U+E0000..E007F, "ASCII
/// smuggling"), variation selectors, interlinear annotation marks, the
/// combining grapheme joiner and Hangul fillers. The paste sanitizer starts
/// from this list too, but uses [`is_invisible_in_context`] so emoji sequences
/// survive in both paths.
pub fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

/// Approximation of Unicode `Extended_Pictographic` (the emoji base set). Only
/// used to decide whether U+FE0F / U+200D belong to an emoji sequence; the web
/// side (`visibleText.ts`) uses the native `\p{Extended_Pictographic}`.
fn is_pictographic(c: char) -> bool {
    let u = c as u32;
    matches!(
        u,
        0xA9 | 0xAE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x2194..=0x2199 | 0x21A9..=0x21AA
            | 0x231A..=0x231B | 0x2328 | 0x2388 | 0x23CF | 0x23E9..=0x23F3 | 0x23F8..=0x23FA
            | 0x24C2 | 0x25AA..=0x25AB | 0x25B6 | 0x25C0 | 0x25FB..=0x25FE | 0x2600..=0x27BF
            | 0x2934..=0x2935 | 0x2B05..=0x2B07 | 0x2B1B..=0x2B1C | 0x2B50 | 0x2B55 | 0x3030
            | 0x303D | 0x3297 | 0x3299 | 0x1F000..=0x1F0FF | 0x1F10D..=0x1F10F | 0x1F12F
            | 0x1F16C..=0x1F171 | 0x1F17E..=0x1F17F | 0x1F18E | 0x1F191..=0x1F19A
            | 0x1F1AD..=0x1F1E5 | 0x1F201..=0x1F20F | 0x1F21A | 0x1F22F | 0x1F232..=0x1F23A
            | 0x1F23C..=0x1F23F | 0x1F249..=0x1F3FA | 0x1F400..=0x1F53D | 0x1F546..=0x1F64F
            | 0x1F680..=0x1F6FF | 0x1F774..=0x1F77F | 0x1F7D5..=0x1F7FF | 0x1F80C..=0x1F80F
            | 0x1F848..=0x1F84F | 0x1F85A..=0x1F85F | 0x1F888..=0x1F88F | 0x1F8AE..=0x1F8FF
            | 0x1F90C..=0x1F93A | 0x1F93C..=0x1F945 | 0x1F947..=0x1FAFF | 0x1FC00..=0x1FFFD
    )
}

/// Whether `c` is shown as `<U+XXXX>` in review text. Same as [`is_invisible`]
/// except that an emoji's presentation selector (U+FE0E/U+FE0F directly after a
/// pictographic base) and the ZWJ joining two emoji (`prev_emoji` before it, a
/// pictographic character after it) pass through. `prev_emoji` is true when
/// the previous character was a pictographic base, a skin-tone modifier, or a
/// presentation selector that itself passed. Everything else (a lone selector,
/// VS1-14, tags, bidi controls, a ZWJ at the start or between text) is still
/// flagged.
pub fn is_invisible_in_context(c: char, prev_emoji: bool, next: Option<char>) -> bool {
    if !is_invisible(c) {
        return false;
    }
    match c {
        '\u{FE0E}' | '\u{FE0F}' => !prev_emoji,
        '\u{200D}' => !(prev_emoji && next.is_some_and(is_pictographic)),
        _ => true,
    }
}

/// The `prev_emoji` state after `c` (see [`is_invisible_in_context`]); `flagged`
/// is that function's verdict for `c`.
pub fn emoji_state_after(c: char, prev_emoji: bool, flagged: bool) -> bool {
    let was_selector = matches!(c, '\u{FE0E}' | '\u{FE0F}');
    is_pictographic(c)
        || ('\u{1F3FB}'..='\u{1F3FF}').contains(&c)
        || (prev_emoji && was_selector && !flagged)
}

/// Strip control characters from a comment body, path, or name.
///
/// - CRLF, lone CR, U+2028 and U+2029 become `\n`.
/// - C0 controls (except `\n` and `\t`), DEL and C1 controls are removed (so an
///   ESC byte disappears and `\e[201~` is left as inert text).
/// - Bidi and zero-width characters are shown as `<U+202E>`.
/// - With `keep_newlines == false` (a single-line value such as a path) `\n` and
///   `\t` are shown as the two-character literals `\n` and `\t`.
pub fn sanitize_review_text(input: &str, keep_newlines: bool) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    // True while the previous character can be followed by an emoji
    // presentation selector or joiner (see `is_invisible_in_context`).
    let mut prev_emoji = false;
    while let Some(c) = chars.next() {
        let next = chars.peek().copied();
        let flagged = is_invisible_in_context(c, prev_emoji, next);
        prev_emoji = emoji_state_after(c, prev_emoji, flagged);
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                push_newline(&mut out, keep_newlines);
            }
            '\n' | '\u{2028}' | '\u{2029}' => push_newline(&mut out, keep_newlines),
            '\t' => {
                if keep_newlines {
                    out.push('\t');
                } else {
                    out.push_str("\\t");
                }
            }
            c if (c as u32) < 0x20 || c == '\u{7f}' || ('\u{80}'..='\u{9f}').contains(&c) => {}
            c if flagged => out.push_str(&format!("<U+{:04X}>", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn push_newline(out: &mut String, keep: bool) {
    if keep {
        out.push('\n');
    } else {
        out.push_str("\\n");
    }
}

/// Strip the control characters a comment must never store (write time): C0
/// controls except `\n` and `\t`, DEL and C1 controls are removed, CRLF / CR /
/// U+2028 / U+2029 become `\n`. Bidi and zero-width characters are kept (a quote
/// must still match the file it came from) and shown as `<U+202E>` at render.
pub fn strip_control_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{2028}' | '\u{2029}' => out.push('\n'),
            '\n' | '\t' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{7f}' || ('\u{80}'..='\u{9f}').contains(&c) => {}
            c => out.push(c),
        }
    }
    out
}

/// True when a repo / artifact path contains a character that could forge or
/// corrupt a rendered item (any C0 control, DEL, or NUL). Creation rejects it
/// with `invalid_path`.
pub fn path_has_control(path: &str) -> bool {
    path.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
}

/// A sanitized body with trailing newlines removed.
fn body(input: &str) -> String {
    sanitize_review_text(input, true)
        .trim_end_matches('\n')
        .to_string()
}

/// Push `   <label>: value` for a one-line body, or `   <label>:` and a
/// `   | `-prefixed line per body line for a multi-line one.
fn push_body(out: &mut String, label: &str, raw: &str, quoted: bool) {
    let b = body(raw);
    if b.contains('\n') {
        out.push_str(&format!("   {label}:\n"));
        for line in b.split('\n') {
            out.push_str(BODY_PREFIX);
            out.push_str(line);
            out.push('\n');
        }
    } else if quoted {
        out.push_str(&format!("   {label}: \"{}\"\n", b.replace('"', "\\\"")));
    } else if b.is_empty() {
        out.push_str(&format!("   {label}:\n"));
    } else {
        out.push_str(&format!("   {label}: {b}\n"));
    }
}

fn scope_label(s: DiffScope) -> &'static str {
    match s {
        DiffScope::Local => "local changes",
        DiffScope::Branch => "branch changes",
    }
}

fn item(out: &mut String, c: &ReviewCommentSnapshot) {
    use crate::review::AnchorState;
    let suffix = match c.anchor {
        AnchorState::Outdated => " (outdated)",
        AnchorState::FileMissing => " (file no longer exists)",
        AnchorState::Anchored | AnchorState::CantCheck => "",
    };
    out.push_str(&format!(
        "{}) File: {}{suffix}\n",
        c.pin,
        sanitize_review_text(&c.path, false)
    ));
    let mut meta: Vec<String> = Vec::new();
    if let Some(l) = c.lines {
        meta.push(if l.start == l.end || l.end == 0 {
            format!("Lines: {}", l.start)
        } else {
            format!("Lines: {}–{}", l.start, l.end)
        });
    }
    if let Some(side) = c.side {
        meta.push(format!(
            "Side: {}",
            match side {
                DiffSide::Old => "old",
                DiffSide::New => "new",
            }
        ));
    }
    if let Some(scope) = c.diff_scope {
        meta.push(format!("Scope: {}", scope_label(scope)));
    }
    if !meta.is_empty() {
        out.push_str(&format!("   {}\n", meta.join("   ")));
    }
    if !c.quote.is_empty() {
        push_body(out, "Quote", &c.quote, true);
    }
    push_body(out, "Comment", &c.text, false);
}

/// Bytes one comment adds to the block: a blank line plus its item. The sum over
/// a block plus the header line is the block's size (less the trimmed final
/// newline). Stored as `blockBytes` for the UI's limit pre-check.
pub fn block_bytes(c: &ReviewCommentSnapshot) -> u32 {
    let mut out = String::new();
    item(&mut out, c);
    u32::try_from(out.len() + 1).unwrap_or(u32::MAX)
}

/// Render the comments block (without any leading message): the header, then
/// one item per comment ordered by (path, first line, pin).
pub fn render_review_block(name: &str, comments: &[ReviewCommentSnapshot]) -> String {
    let mut sorted: Vec<&ReviewCommentSnapshot> = comments.iter().collect();
    sorted.sort_by(|a, b| {
        (&a.path, a.lines.map_or(0, |l| l.start), a.pin).cmp(&(
            &b.path,
            b.lines.map_or(0, |l| l.start),
            b.pin,
        ))
    });
    let name = sanitize_review_text(name, false);
    let mut out = if name.is_empty() {
        format!("Review comments ({})\n", sorted.len())
    } else {
        format!("Review comments ({}) · {name}\n", sorted.len())
    };
    for c in sorted {
        out.push('\n');
        item(&mut out, c);
    }
    out.truncate(out.trim_end_matches('\n').len());
    out
}

/// Bytes left for the comments block under a paste cap of `cap`, after the
/// user's `message` and the blank-line joiner `render_review_message` adds
/// (only when the message is not blank).
pub fn block_budget(cap: usize, message: &str) -> usize {
    let msg = message.trim_end();
    if msg.trim().is_empty() {
        cap
    } else {
        cap.saturating_sub(msg.len() + 2)
    }
}

/// The full message: the user's `message` (when not blank), a blank line, then
/// the comments block. With an empty message it is the block alone. The Rich
/// Chat run-time append passes an empty message and adds its own separator.
pub fn render_review_message(
    name: &str,
    message: &str,
    comments: &[ReviewCommentSnapshot],
) -> String {
    let block = render_review_block(name, comments);
    if message.trim().is_empty() {
        block
    } else {
        format!("{}\n\n{block}", message.trim_end())
    }
}

#[cfg(test)]
mod block_budget_tests {
    use super::block_budget;

    #[test]
    fn a_blank_message_leaves_the_whole_cap_and_text_pays_for_its_joiner() {
        assert_eq!(block_budget(100, ""), 100);
        assert_eq!(block_budget(100, "  \n"), 100);
        assert_eq!(block_budget(100, "abc\n"), 95);
        assert_eq!(block_budget(4, "abcdef"), 0);
    }
}
