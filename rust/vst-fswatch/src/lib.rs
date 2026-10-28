#![forbid(unsafe_code)]
//! `vst-fswatch` — the one `notify` backend of the daemon.
//!
//! Extracted from `vst-ws` as a pure move so crates below `vst-ws` (the review
//! comments owner) can watch files without depending on the WebSocket layer.
//! `vst-ws` re-exports [`file_watcher`] and [`ignore_filter`] at their old paths.
//!
//! - [`file_watcher::FileWatcher`]: debounced tree / single-file watch for the WS
//!   handlers and the LSP manager.
//! - [`ignore_filter`]: nested-gitignore-aware matcher.
//! - [`path_watcher::PathWatcher`]: a bounded watcher over the parent directories
//!   of commented paths plus a worktree's git state files.
//!
//! Dependencies: `vst-types` only (CLI-agnostic, no I/O beyond the OS watch API).

pub mod file_watcher;
pub mod ignore_filter;
pub mod path_watcher;
