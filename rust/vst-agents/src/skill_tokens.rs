//! skill-invocation-in-chat REPLAN Phase 7 (D2/D3) — tokenizer, serializer,
//! and escaper for the flat inline-chip grammar (ports `services/skillTokens.ts`).
//!
//!   segments := (text | token)*
//!   token    := "{/" name (" " args)? "}"
//!   name     := longest catalog match, opaque non-whitespace (may contain : and /)
//!   args     := everything to the token's closing "}"
//!
//! Escaping is CONTEXT-FREE (D3): in plain text, `\` -> `\\` and `{` -> `\{`;
//! inside a token's args, additionally `}` -> `\}`. This makes tokenization
//! catalog-INDEPENDENT and guarantees `parse(serialize(x)) == x` for ANY
//! segment list. The same grammar is implemented independently in web-ui's
//! `skillInvocation.ts`; the identical test-vector table in both suites keeps
//! the two byte-identical.

/// One literal-text run between (or around) tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillSegment {
    Text(String),
    Token { name: String, args: String },
}

impl SkillSegment {
    pub fn is_token(&self) -> bool {
        matches!(self, SkillSegment::Token { .. })
    }
}

/// Escape a plain-text run for serialization: `\` -> `\\`, `{` -> `\{`.
pub fn escape_skill_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape a token's args for serialization: text escaping PLUS `}` -> `\}`.
pub fn escape_skill_args(args: &str) -> String {
    let mut out = String::with_capacity(args.len());
    for c in args.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            _ => out.push(c),
        }
    }
    out
}

/// Parse one `{/name[ args]}` token starting at `input[start] == "{"` (with
/// `input[start + 1] == "/"` already confirmed by the caller). Returns `None`
/// when unterminated (no unescaped closing `}` before the end of the string) —
/// the caller then treats the leading `{` as ordinary literal text.
fn try_parse_token(input: &[u8], start: usize) -> Option<(String, String, usize)> {
    let n = input.len();
    let mut j = start + 2; // skip "{/"
    let mut name = String::new();
    while j < n && input[j] != b' ' && input[j] != b'}' {
        name.push(input[j] as char);
        j += 1;
    }
    if j >= n {
        return None; // unterminated — no closing '}' or ' ' found
    }
    if input[j] == b'}' {
        return Some((name, String::new(), j));
    }
    // input[j] == ' ' — the single separator between name and args.
    j += 1;
    let mut args = String::new();
    while j < n {
        let c = input[j];
        if c == b'\\'
            && j + 1 < n
            && (input[j + 1] == b'\\' || input[j + 1] == b'{' || input[j + 1] == b'}')
        {
            args.push(input[j + 1] as char);
            j += 2;
            continue;
        }
        if c == b'}' {
            return Some((name, args, j));
        }
        args.push(c as char);
        j += 1;
    }
    None // unterminated — no closing '}' found
}

/// Parse a flat message string into a `(text | token)*` segment list. Never
/// fails: an unterminated `{/...` degrades to literal text, and a `\` escape
/// that doesn't match one of the defined targets is left as a literal
/// backslash.
pub fn parse_skill_segments(input: &str) -> Vec<SkillSegment> {
    let bytes = input.as_bytes();
    let mut segments: Vec<SkillSegment> = Vec::new();
    let mut buf = String::new();
    let mut i = 0;
    let n = bytes.len();

    let flush = |segments: &mut Vec<SkillSegment>, buf: &mut String| {
        if !buf.is_empty() {
            segments.push(SkillSegment::Text(std::mem::take(buf)));
        }
    };

    while i < n {
        let c = bytes[i];
        if c == b'\\' && i + 1 < n && (bytes[i + 1] == b'\\' || bytes[i + 1] == b'{') {
            buf.push(bytes[i + 1] as char);
            i += 2;
            continue;
        }
        if c == b'{' && bytes[i + 1] == b'/' {
            if let Some((name, args, end)) = try_parse_token(bytes, i) {
                flush(&mut segments, &mut buf);
                segments.push(SkillSegment::Token { name, args });
                i = end + 1;
                continue;
            }
            // No matching unescaped '}' — not a token; fall through, '{' literal.
        }
        buf.push(c as char);
        i += 1;
    }
    flush(&mut segments, &mut buf);
    segments
}

/// Serialize a segment list back to the flat string form — the inverse of `parse_skill_segments`.
pub fn serialize_skill_segments(segments: &[SkillSegment]) -> String {
    let mut out = String::new();
    for seg in segments {
        match seg {
            SkillSegment::Text(text) => out.push_str(&escape_skill_text(text)),
            SkillSegment::Token { name, args } => {
                if args.is_empty() {
                    out.push_str(&format!("{{/{name}}}"));
                } else {
                    out.push_str(&format!("{{/{name} {}}}", escape_skill_args(args)));
                }
            }
        }
    }
    out
}
