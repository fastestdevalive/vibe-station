//! Behavior contract for `shell.ts` (part 02-process-pty).
//! Ported from `daemon/src/services/shell.ts` and its semantics: single-quote
//! wrapping for POSIX shells, escaping any embedded single quotes.

use vst_proc::sq;

#[test]
fn wraps_in_single_quotes() {
    assert_eq!(sq("hello"), "'hello'");
}

#[test]
fn escapes_embedded_single_quotes() {
    // TS: `'${s.replace(/'/g, `'\\''`)}'` — an embedded `'` becomes `'\''`.
    assert_eq!(sq("it's"), "'it'\\''s'");
}

#[test]
fn empty_string() {
    assert_eq!(sq(""), "''");
}

#[test]
fn path_with_spaces_and_quotes() {
    // Paths are the primary use case: space stays inside the quotes, a quote is
    // escaped so the POSIX shell does not prematurely close the string.
    assert_eq!(sq("my dir"), "'my dir'");
    assert_eq!(sq("a'b'c"), "'a'\\''b'\\''c'");
}
