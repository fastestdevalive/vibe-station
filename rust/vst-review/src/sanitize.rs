//! Paste-text sanitizer (PRD R77): the text pasted into an agent's terminal
//! must not carry bytes a terminal could interpret (escape sequences, CSI) or
//! characters that can make a reader misjudge what is being sent (bidi
//! overrides, zero-width characters).

use vst_types::review_format::{emoji_state_after, is_invisible_in_context};

/// Whether `c` survives sanitisation. `\n` and `\t` are kept; CR is handled by
/// the caller (normalised to `\n`).
fn keep(c: char) -> bool {
    match c {
        '\n' | '\t' => true,
        // C0 including ESC, and DEL.
        c if (c as u32) < 0x20 || c == '\u{7f}' => false,
        // C1 including U+009B (CSI).
        '\u{80}'..='\u{9f}' => false,
        // Zero-width, bidi, line/paragraph separators, soft hyphen, invisible
        // operators.
        '\u{200b}'..='\u{200f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2060}'
        | '\u{2066}'..='\u{2069}'
        | '\u{feff}'
        | '\u{061c}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{00ad}'
        | '\u{180e}'
        | '\u{2061}'..='\u{2064}' => false,
        // Tag characters, variation selectors, annotation marks, CGJ, Hangul
        // fillers (the shared list the review renderer also shows as `<U+XXXX>`).
        c if vst_types::review_format::is_invisible(c) => false,
        _ => true,
    }
}

/// Strip everything a terminal could interpret or a reader could be fooled by.
///
/// `\r\n` and a lone `\r` become `\n`; `\n` and `\t` are kept; C0 (incl. ESC,
/// DEL), C1 (incl. U+009B), bidi controls, zero-width characters and
/// line/paragraph separators are dropped. Idempotent. Input that is only
/// whitespace after stripping returns the empty string, so callers can reject
/// "needs text" with one `is_empty()`.
pub fn sanitize_paste_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    // As in the review renderer: an emoji's presentation selector and the ZWJ
    // joining two emoji pass; a stand-alone one is stripped.
    let mut prev_emoji = false;
    while let Some(c) = chars.next() {
        let next = chars.peek().copied();
        let flagged = is_invisible_in_context(c, prev_emoji, next);
        let emoji_joiner = matches!(c, '\u{200d}' | '\u{fe0e}' | '\u{fe0f}') && !flagged;
        prev_emoji = emoji_state_after(c, prev_emoji, flagged);
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else if emoji_joiner || keep(c) {
            out.push(c);
        }
    }
    if out.trim().is_empty() {
        out.clear();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sanitize_paste_text;

    #[test]
    fn strips_every_listed_control_and_invisible_character() {
        for c in [
            '\u{1b}',
            '\u{0}',
            '\u{7f}',
            '\u{9b}',
            '\u{202e}',
            '\u{200b}',
            '\u{feff}',
            '\u{2028}',
            '\u{2029}',
            '\u{00ad}',
            '\u{180e}',
            '\u{2061}',
            '\u{2062}',
            '\u{2063}',
            '\u{2064}',
            '\u{200f}',
            '\u{2060}',
            '\u{e0041}',
            '\u{e007f}',
            '\u{fe0f}',
            '\u{fe00}',
            '\u{e0100}',
            '\u{e01ef}',
            '\u{fff9}',
            '\u{fffb}',
            '\u{34f}',
            '\u{115f}',
            '\u{1160}',
            '\u{3164}',
            '\u{ffa0}',
            '\u{2066}',
            '\u{2069}',
            '\u{061c}',
            '\u{80}',
            '\u{9f}',
        ] {
            let input = format!("a{c}b");
            assert_eq!(sanitize_paste_text(&input), "ab", "U+{:04X}", c as u32);
        }
    }

    #[test]
    fn strips_an_escape_sequence_introducer_but_keeps_its_printable_tail() {
        // The ESC byte is what makes it a sequence; the rest is plain text.
        assert_eq!(sanitize_paste_text("x\u{1b}[31my"), "x[31my");
    }

    #[test]
    fn keeps_emoji_sequences_but_strips_stand_alone_joiners() {
        let s = "\u{26A0}\u{FE0F} \u{1F469}\u{200D}\u{1F4BB}";
        assert_eq!(sanitize_paste_text(s), s);
        assert_eq!(sanitize_paste_text("a\u{200d}b"), "ab");
        assert_eq!(sanitize_paste_text("a\u{fe0f}b"), "ab");
    }

    #[test]
    fn keeps_newline_tab_emoji_and_cjk() {
        let s = "line1\n\tline2 \u{1F600} \u{4F60}\u{597D}";
        assert_eq!(sanitize_paste_text(s), s);
    }

    #[test]
    fn normalises_crlf_and_lone_cr_to_lf() {
        assert_eq!(sanitize_paste_text("a\r\nb\rc\n\rd"), "a\nb\nc\n\nd");
    }

    #[test]
    fn is_idempotent() {
        let once = sanitize_paste_text("a\r\n\u{1b}b\u{202e}c\rd\t");
        assert_eq!(sanitize_paste_text(&once), once);
    }

    #[test]
    fn whitespace_only_becomes_empty() {
        for s in ["", " ", "\n\t\r\n", "\u{200b}\u{1b} \n"] {
            assert_eq!(sanitize_paste_text(s), "", "{s:?}");
        }
    }
}
