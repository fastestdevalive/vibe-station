#![deny(unsafe_code)]

//! vst-proc — tmux/PTY/subprocess spawning behind a `PtyBackend` trait.
//!
//! This crate is the documented PTY/FFI boundary: it uses `#![deny(unsafe_code)]`
//! (not `forbid`) so a later part may add a documented, SAFETY-commented `unsafe`
//! block at the PTY syscall boundary. See daemon-rust-port arch doc Gotcha "vst-proc".
//!
//! Ports (part 02-process-pty, per `file-map.tsv`):
//! - `services/tmux.ts`            → [`tmux`] (`Tmux` command wrappers)
//! - `services/directPty.ts`       → [`pty`] (`PtyHandle`, `spawn_child`)
//! - `services/childStreams.ts`    → [`child_stdio`] (`classify_child_stdio_error`)
//! - `services/shell.ts`           → [`shell`] (`sq`)
//! - `services/resolveUseTmux.ts`  → [`resolve_use_tmux`]
//!
//! Public interface target (arch Entities & Modules row for `vst-proc`):
//! [`PtyHandle`], [`spawn_tmux`], [`spawn_child`], [`trait PtyBackend`].

pub mod child_stdio;
pub mod error;
pub mod pty;
pub mod raw_fd_write;
pub mod resolve_use_tmux;
pub mod shell;
pub mod tmux;

pub use child_stdio::{classify_child_stdio_error, StdioErrorClass};
pub use error::{ProcError, TmuxError};
pub use pty::{
    spawn_child, spawn_tmux, NativePtyBackend, PtyBackend, PtyHandle, SpawnChildOptions,
    TmuxSpawnOptions,
};
pub use raw_fd_write::write_borrowed_fd;
pub use resolve_use_tmux::resolve_use_tmux;
pub use shell::sq;
pub use tmux::{ListErrorClass, NewSessionOptions, Tmux};
