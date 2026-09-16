//! A single, documented `unsafe` FFI boundary: write to a **borrowed** raw
//! fd without constructing any RAII wrapper that would close it (or do
//! anything else) when dropped.
//!
//! This exists specifically for `vst-ws`'s `TmuxOutputStream::write()`
//! (`#![forbid(unsafe_code)]`, so it cannot do this itself). That stream
//! writes keystrokes into a `portable_pty::MasterPty`'s underlying fd, but
//! MUST NOT use `MasterPty::take_writer()` for it: `take_writer()`'s own
//! doc comment says "Dropping the writer will send EOF to the slave end",
//! and portable-pty's `UnixMasterWriter::drop()` does exactly that —
//! unconditionally writing a synthetic `\n` + the terminal's EOF character
//! into the pty before closing its own `try_clone()`'d duplicate fd. For a
//! `tmux attach-session` child on the other end, that phantom EOF is
//! indistinguishable from the user pressing Ctrl-D and gets forwarded
//! straight through as real input to the active pane's shell — which, at
//! an empty prompt, exits, killing the pane and (being the session's only
//! pane) the whole tmux session. This was live-reproduced as "terminal
//! exits on tap" / "terminal-mode agents don't accept input" (every
//! keystroke used to `take_writer()` fresh and drop it immediately) and,
//! even after fixing that to take the writer once per stream lifetime,
//! recurred as "session dies right when you detach/switch tabs" (dropping
//! the once-held writer in `detach()` still sends the same phantom EOF).
//!
//! Writing through the fd directly, borrowed rather than owned/duplicated,
//! has no such side effect and leaves the actual close (of the real,
//! non-duplicated fd) exactly where it already was: `MasterPty`'s own
//! `Drop`, run whenever `vst-ws` clears its `Mutex<Option<Box<dyn
//! MasterPty>>>` in `detach()`.

use std::os::unix::io::RawFd;

/// Write `data` to `fd`, which must be a valid, open, writable file
/// descriptor for the full duration of this call, OWNED BY THE CALLER (this
/// function never closes it, on success or on error).
///
/// Best-effort, matching the pre-existing tolerance at this call site: a
/// partial write or an error (e.g. EPIPE because the far end just hung up)
/// is silently ignored, same as the `let _ = w.write_all(...)` this
/// replaces.
#[allow(unsafe_code)]
pub fn write_borrowed_fd(fd: RawFd, data: &[u8]) {
    let mut offset = 0usize;
    while offset < data.len() {
        // SAFETY: `libc::write` takes a raw fd by value and does not take
        // ownership of it (no implicit close, no destructor of any kind) —
        // unlike wrapping `fd` in an owned `File`/`OwnedFd`, which is
        // exactly the ownership/closing semantics this function exists to
        // avoid (see module doc comment). `fd` is required by this
        // function's contract to be a valid, open, writable fd for the
        // duration of this call; `data[offset..]`'s pointer and length are
        // a valid slice we hold a live reference to for the syscall's
        // duration.
        let n = unsafe {
            libc::write(
                fd,
                data[offset..].as_ptr() as *const libc::c_void,
                data.len() - offset,
            )
        };
        if n <= 0 {
            // EOF/error/EINTR/EAGAIN on a best-effort write: stop silently,
            // matching the `let _ = ...` tolerance this replaces.
            break;
        }
        offset += n as usize;
    }
}
