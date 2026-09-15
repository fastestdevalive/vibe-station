//! Shell-quoting utilities (ports `services/shell.ts`).
//! No external dependencies.

/// Single-quote-wrap a string, escaping any embedded single quotes. POSIX-safe
/// for sh/bash. Use this for all user-controlled or path values inserted into
/// shell command strings.
///
/// Mirrors the TS `'${s.replace(/'/g, `'\\''`)}'`: an embedded `'` becomes the
/// four-character sequence `'\''` so the outer quoted string is never closed
/// early.
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
