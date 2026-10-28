//! Streams for the WS layer.

/// Moved to `vst-fswatch`; re-exported at its old path.
pub use vst_fswatch::file_watcher;
pub mod pty_stream;
pub mod tmux_output;
