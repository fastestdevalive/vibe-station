//! Markdown source to the plain text a reader sees, line by line.
//!
//! The `markdown` comment surface quotes RENDERED text (bold, links and table
//! pipes are not in the quote) while the file holds the source. Anchoring
//! therefore compares the quote against this plain form. Lines keep their
//! source line numbers so a match maps back to a source span.
//!
//! Deliberately a line scanner, not a full CommonMark parser: it handles what a
//! quote can contain (block prefixes, emphasis, inline code, links, images,
//! entities, tables, fences) and leaves anything else as written. Whitespace is
//! collapsed later by the corpus, so exact spacing here does not matter.

/// Plain text of each source line: `(1-based line number, text)`.
pub fn md_plain_lines(source: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut fence: Option<char> = None;
    for (i, raw) in source.split('\n').enumerate() {
        let line = raw.trim_end_matches('\r');
        let no = u32::try_from(i + 1).unwrap_or(u32::MAX);
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            if is_fence(trimmed, marker) {
                fence = None;
                out.push((no, String::new()));
            } else {
                out.push((no, line.to_string()));
            }
            continue;
        }
        if let Some(marker) = ['`', '~'].into_iter().find(|m| is_fence(trimmed, *m)) {
            fence = Some(marker);
            out.push((no, String::new()));
            continue;
        }
        out.push((no, plain_line(line)));
    }
    out
}

fn is_fence(trimmed: &str, marker: char) -> bool {
    trimmed.chars().take_while(|c| *c == marker).count() >= 3
}

fn plain_line(line: &str) -> String {
    let t = line.trim();
    if is_rule(t) || is_table_separator(t) {
        return String::new();
    }
    let mut rest = t;
    // Block quotes can nest: `> > x`.
    while let Some(r) = rest.strip_prefix('>') {
        rest = r.trim_start();
    }
    let mut body = rest.to_string();
    if let Some(h) = heading_body(rest) {
        body = h;
    } else if let Some(l) = list_body(rest) {
        body = l;
    }
    if body.trim_start().starts_with('|') {
        body = split_table_row(&body);
    }
    strip_inline(&body)
}

/// `---`, `***`, `___` (or `===` setext underlines): three or more of one char.
fn is_rule(t: &str) -> bool {
    let mut chars = t.chars().filter(|c| !c.is_whitespace());
    let Some(first) = chars.next() else {
        return false;
    };
    matches!(first, '-' | '*' | '_' | '=') && t.chars().filter(|c| *c == first).count() >= 3 && {
        t.chars().all(|c| c == first || c.is_whitespace())
    }
}

fn is_table_separator(t: &str) -> bool {
    t.contains('-')
        && t.contains('|')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

fn heading_body(s: &str) -> Option<String> {
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &s[hashes..];
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim().trim_end_matches('#').trim_end().to_string())
}

fn list_body(s: &str) -> Option<String> {
    let after = if let Some(r) = s
        .strip_prefix(['-', '*', '+'])
        .filter(|r| r.starts_with(char::is_whitespace))
    {
        r
    } else {
        let digits = s.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 9 {
            return None;
        }
        let r = s[digits..].strip_prefix(['.', ')'])?;
        if !r.starts_with(char::is_whitespace) {
            return None;
        }
        r
    };
    let after = after.trim_start();
    for task in ["[ ]", "[x]", "[X]"] {
        if let Some(r) = after.strip_prefix(task) {
            return Some(r.trim_start().to_string());
        }
    }
    Some(after.to_string())
}

/// Replace the unescaped `|` cell separators of a table row with spaces.
fn split_table_row(row: &str) -> String {
    let mut out = String::with_capacity(row.len());
    let mut prev = ' ';
    for c in row.chars() {
        if c == '|' && prev != '\\' {
            out.push(' ');
        } else {
            out.push(c);
        }
        prev = c;
    }
    out
}

/// Inline markup to text: escapes, code spans, links, images, autolinks, tags,
/// entities and emphasis markers.
fn strip_inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if chars.get(i + 1).is_some_and(char::is_ascii_punctuation) => {
                out.push(chars[i + 1]);
                i += 2;
            }
            '`' => i = code_span(&chars, i, &mut out),
            '!' if chars.get(i + 1) == Some(&'[') => match link_at(&chars, i + 1) {
                Some((text, next)) => {
                    out.push_str(&strip_inline(&text));
                    i = next;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            },
            '[' => match link_at(&chars, i) {
                Some((text, next)) => {
                    out.push_str(&strip_inline(&text));
                    i = next;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            },
            '<' => i = angle(&chars, i, &mut out),
            '&' => i = entity(&chars, i, &mut out),
            '*' | '~' => {
                let run = chars[i..].iter().take_while(|x| **x == c).count();
                let lone_star = c == '*' && run == 1 && is_space(&chars, i.checked_sub(1)) && {
                    is_space(&chars, Some(i + 1))
                };
                // A single `~` is text (`~5 minutes`); `~~` is strikethrough.
                if lone_star || (c == '~' && run < 2) {
                    out.extend(std::iter::repeat(c).take(run));
                }
                i += run;
            }
            '_' => {
                let run = chars[i..].iter().take_while(|x| **x == '_').count();
                let before = i.checked_sub(1).and_then(|p| chars.get(p));
                let after = chars.get(i + run);
                let intraword = before.is_some_and(|b| b.is_alphanumeric())
                    && after.is_some_and(|a| a.is_alphanumeric());
                if intraword {
                    out.extend(std::iter::repeat('_').take(run));
                }
                i += run;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn is_space(chars: &[char], idx: Option<usize>) -> bool {
    idx.map_or(true, |i| chars.get(i).map_or(true, |c| c.is_whitespace()))
}

/// A code span starting at `i` (a backtick run). Emits its content verbatim.
fn code_span(chars: &[char], i: usize, out: &mut String) -> usize {
    let run = chars[i..].iter().take_while(|c| **c == '`').count();
    let mut j = i + run;
    while j < chars.len() {
        if chars[j] == '`' {
            let close = chars[j..].iter().take_while(|c| **c == '`').count();
            if close == run {
                out.extend(chars[i + run..j].iter());
                return j + close;
            }
            j += close;
        } else {
            j += 1;
        }
    }
    out.extend(std::iter::repeat('`').take(run));
    i + run
}

/// `[text](url)` or `[text][ref]` at `i` (a `[`): the text and the index after it.
fn link_at(chars: &[char], i: usize) -> Option<(String, usize)> {
    let mut depth = 0usize;
    let mut j = i;
    while j < chars.len() {
        match chars[j] {
            '\\' => j += 1,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        j += 1;
    }
    if j >= chars.len() {
        return None;
    }
    let text: String = chars[i + 1..j].iter().collect();
    let (open, close) = match chars.get(j + 1)? {
        '(' => ('(', ')'),
        '[' => ('[', ']'),
        _ => return None,
    };
    let mut k = j + 2;
    let mut nest = 0usize;
    while k < chars.len() {
        match chars[k] {
            c if c == open && open == '(' => nest += 1,
            c if c == close => {
                if nest == 0 {
                    return Some((text, k + 1));
                }
                nest -= 1;
            }
            _ => {}
        }
        k += 1;
    }
    None
}

/// `<https://x>` (keep the URL) or an HTML tag (drop it); else a literal `<`.
fn angle(chars: &[char], i: usize, out: &mut String) -> usize {
    let Some(end) = chars[i..].iter().position(|c| *c == '>').map(|p| i + p) else {
        out.push('<');
        return i + 1;
    };
    let inner: String = chars[i + 1..end].iter().collect();
    if inner.contains("://") || (inner.contains('@') && !inner.contains(' ')) {
        out.push_str(&inner);
        return end + 1;
    }
    let first = inner.chars().next();
    if first.is_some_and(|c| c.is_ascii_alphabetic() || c == '/' || c == '!') {
        return end + 1;
    }
    out.push('<');
    i + 1
}

/// `&amp;`, `&#39;`, `&#x27;`, `&nbsp;`: decoded; unknown entities stay literal.
fn entity(chars: &[char], i: usize, out: &mut String) -> usize {
    let Some(end) = chars[i + 1..]
        .iter()
        .take(10)
        .position(|c| *c == ';')
        .map(|p| i + 1 + p)
    else {
        out.push('&');
        return i + 1;
    };
    let name: String = chars[i + 1..end].iter().collect();
    let decoded = match name.as_str() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        n => n
            .strip_prefix("#x")
            .or_else(|| n.strip_prefix("#X"))
            .and_then(|h| u32::from_str_radix(h, 16).ok())
            .or_else(|| n.strip_prefix('#').and_then(|d| d.parse().ok()))
            .and_then(char::from_u32),
    };
    match decoded {
        Some(c) => {
            out.push(c);
            end + 1
        }
        None => {
            out.push('&');
            i + 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(src: &str) -> Vec<String> {
        md_plain_lines(src).into_iter().map(|(_, t)| t).collect()
    }

    fn one(src: &str) -> String {
        plain(src).remove(0)
    }

    #[test]
    fn emphasis_and_strike_are_removed_but_snake_case_and_math_stay() {
        assert_eq!(
            one("a **bold** and *it* and __b__ and _i_ ~~x~~"),
            "a bold and it and b and i x"
        );
        assert_eq!(one("call snake_case_name now"), "call snake_case_name now");
        assert_eq!(one("2 * 3 ~5 minutes"), "2 * 3 ~5 minutes");
        assert_eq!(one("***both***"), "both");
    }

    #[test]
    fn links_images_and_autolinks_keep_their_text() {
        assert_eq!(
            one("see [the docs](https://x.y/z_(1)) now"),
            "see the docs now"
        );
        assert_eq!(one("![alt text](img.png) after"), "alt text after");
        assert_eq!(one("[ref link][r1] and [bare]"), "ref link and [bare]");
        assert_eq!(one("<https://example.com> ok"), "https://example.com ok");
        assert_eq!(one("a <b>tag</b> here"), "a tag here");
        assert_eq!(one("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
    }

    #[test]
    fn inline_code_is_verbatim() {
        assert_eq!(one("run `cargo **test**` now"), "run cargo **test** now");
        assert_eq!(one("`` a ` b ``"), " a ` b ");
        assert_eq!(one("unterminated ` tick"), "unterminated ` tick");
    }

    #[test]
    fn headings_quotes_and_lists_lose_their_markers() {
        assert_eq!(
            plain("# Title #\n## Sub\n####### seven"),
            ["Title", "Sub", "####### seven"]
        );
        assert_eq!(one("> > quoted *text*"), "quoted text");
        assert_eq!(
            plain("- one\n* two\n+ three\n1. four\n2) five"),
            ["one", "two", "three", "four", "five"]
        );
        assert_eq!(plain("- [ ] todo\n- [x] done"), ["todo", "done"]);
        assert_eq!(one("-not a list"), "-not a list");
        assert_eq!(one("2024-01-01 date"), "2024-01-01 date");
    }

    #[test]
    fn tables_keep_cells_and_drop_the_separator_row() {
        let rows = plain("| Name | **Qty** |\n|------|:-----:|\n| apple | 3 |");
        assert_eq!(
            rows[0].split_whitespace().collect::<Vec<_>>(),
            ["Name", "Qty"]
        );
        assert_eq!(rows[1], "");
        assert_eq!(
            rows[2].split_whitespace().collect::<Vec<_>>(),
            ["apple", "3"]
        );
        assert_eq!(one(r"| a \| b |").trim(), "a | b");
    }

    #[test]
    fn entities_and_escapes_decode() {
        assert_eq!(
            one("Tom &amp; Jerry &lt;3 &quot;q&quot; &#39;x&#x27;"),
            "Tom & Jerry <3 \"q\" 'x'"
        );
        assert_eq!(one("a&nbsp;b &bogus; &"), "a b &bogus; &");
        assert_eq!(one(r"\*not bold\* and \_x\_"), "*not bold* and _x_");
    }

    #[test]
    fn fences_and_rules_blank_their_lines_but_keep_code_text() {
        let src = "intro\n```rust\nlet x = **y**;\n```\n---\nafter";
        let got = plain(src);
        assert_eq!(got, ["intro", "", "let x = **y**;", "", "", "after"]);
        let lines = md_plain_lines(src);
        assert_eq!(lines[5].0, 6, "line numbers stay source numbers");
    }
}
