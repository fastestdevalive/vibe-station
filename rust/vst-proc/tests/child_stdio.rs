//! Behavior contract for `childStreams.ts` (part 02-process-pty).
//!
//! The TS `guardChildStdio` installs `'error'` listeners on a child's
//! stdin/stdout/stderr so an `EPIPE`/`ECONNRESET` on a dying child's pipe does
//! not crash the whole daemon (Node's default for an unhandled stream `'error'`
//! is to throw out of the event loop and kill the process).
//!
//! Rust has no "unhandled stream error kills the process" behaviour, so the
//! portable, meaningful contract is the *classification* the guard encodes:
//! `EPIPE`/`ECONNRESET` on a dying child are expected and silently tolerated,
//! while any other error is genuinely unusual (logged, never fatal). The
//! Node-only tests (a bare EventEmitter throwing, a child with no piped stdio)
//! do not translate to Rust and are deliberately not ported.

use std::io::{Error, ErrorKind};
use vst_proc::{classify_child_stdio_error, StdioErrorClass};

#[test]
fn epipe_is_benign_on_every_io_surface() {
    let epipe = Error::from(ErrorKind::BrokenPipe);
    assert!(matches!(
        classify_child_stdio_error(&epipe),
        StdioErrorClass::BenignDying
    ));
}

#[test]
fn econnreset_is_benign() {
    let econnreset = Error::from(ErrorKind::ConnectionReset);
    assert!(matches!(
        classify_child_stdio_error(&econnreset),
        StdioErrorClass::BenignDying
    ));
}

#[test]
fn unexpected_error_is_unusual_but_not_fatal() {
    let eacces = Error::from(ErrorKind::PermissionDenied);
    // Classification says "log it", and it must not panic.
    assert!(matches!(
        classify_child_stdio_error(&eacces),
        StdioErrorClass::Unusual
    ));
}

#[test]
fn other_common_kinds_are_unusual() {
    for kind in [
        ErrorKind::NotFound,
        ErrorKind::TimedOut,
        ErrorKind::WouldBlock,
        ErrorKind::UnexpectedEof,
    ] {
        let err = Error::from(kind);
        assert!(
            matches!(classify_child_stdio_error(&err), StdioErrorClass::Unusual),
            "kind {kind:?} should be classified unusual"
        );
    }
}
