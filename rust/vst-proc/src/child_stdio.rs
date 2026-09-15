//! Child-stdio error guarding (ports `services/childStreams.ts`).
//!
//! The TS `guardChildStdio` installs `'error'` listeners on a child's
//! stdin/stdout/stderr so an `EPIPE` or `ECONNRESET` on a dying child's pipe
//! does not take the whole daemon down (Node's default for an unhandled stream
//! `'error'` is to throw out of the event loop and kill the process).
//!
//! Rust has no "unhandled stream error kills the process" behaviour, so this
//! module ports the *classification* the guard encodes: `EPIPE`/`ECONNRESET`
//! on a dying child are expected and silently tolerated, while any other error
//! is genuinely unusual (log it — never fatal). Callers (e.g. the PTY write
//! path) apply this before deciding whether to surface or swallow an error.

use std::io;

/// How to treat an `io::Error` arising from a child's stdio pipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioErrorClass {
    /// `EPIPE`/`ECONNRESET` on a dying child — expected, silently tolerated.
    BenignDying,
    /// Anything else — genuinely unusual; log it, but it is never fatal.
    Unusual,
}

/// Classify a child-stdio `io::Error`. `BrokenPipe` (EPIPE) and
/// `ConnectionReset` (ECONNRESET) are `BenignDying`; every other kind is
/// `Unusual`. This mirrors the TS guard's `err.code === "EPIPE" ||
/// err.code === "ECONNRESET"` check.
pub fn classify_child_stdio_error(err: &io::Error) -> StdioErrorClass {
    match err.kind() {
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset => StdioErrorClass::BenignDying,
        _ => StdioErrorClass::Unusual,
    }
}
