//! The tmux operations a delivery job needs, as a trait so the job can be
//! tested against a scripted pane. [`Tmux`] is the production implementation.
//!
//! Every method is synchronous (like `vst-proc`'s wrapper); the job calls them
//! through `spawn_blocking`. Targets are passed verbatim: the job always uses
//! the exact form `=<name>:` so a name never prefix-matches a sibling session.

use std::collections::HashSet;

use vst_proc::tmux::{PaneFlags, Tmux};
use vst_types::terminal_delivery::PaneSnapshot;

/// Pane access for terminal delivery. Errors are sanitized stderr text (never
/// message content).
pub trait PaneIo: Send + Sync + 'static {
    /// Live tmux session names; `None` = tmux failed in a way we cannot
    /// interpret (a transient: callers keep waiting).
    fn list_session_names(&self) -> Option<HashSet<String>>;
    /// Copy-mode and dead-pane flags; `None` = missing or not understood.
    fn pane_flags(&self, target: &str) -> Option<PaneFlags>;
    /// The visible screen and cursor of `target`.
    fn capture(&self, target: &str) -> Result<PaneSnapshot, String>;
    /// Leave copy mode.
    fn cancel_mode(&self, target: &str) -> Result<(), String>;
    /// One bracketed paste of `text` into `target`.
    fn paste(&self, target: &str, buffer_id: &str, text: &str, raw_lf: bool) -> Result<(), String>;
    /// Press Enter.
    fn send_enter(&self, target: &str) -> Result<(), String>;
}

/// Stderr text safe to store and show: control characters dropped, bounded.
pub(crate) fn clean_stderr(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(200).collect()
}

impl PaneIo for Tmux {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Tmux::list_session_names(self)
    }

    fn pane_flags(&self, target: &str) -> Option<PaneFlags> {
        Tmux::pane_flags(self, target)
    }

    fn capture(&self, target: &str) -> Result<PaneSnapshot, String> {
        let text = self
            .capture_screen(target)
            .map_err(|e| clean_stderr(e.stderr()))?;
        let (cursor_x, cursor_y) = self
            .pane_cursor(target)
            .ok_or_else(|| "cursor position unavailable".to_string())?;
        Ok(PaneSnapshot {
            text,
            cursor_x,
            cursor_y,
        })
    }

    fn cancel_mode(&self, target: &str) -> Result<(), String> {
        Tmux::cancel_mode(self, target).map_err(|e| clean_stderr(e.stderr()))
    }

    fn paste(&self, target: &str, buffer_id: &str, text: &str, raw_lf: bool) -> Result<(), String> {
        self.paste_buffer_with(target, buffer_id, text, raw_lf)
            .map_err(|e| clean_stderr(e.stderr()))
    }

    fn send_enter(&self, target: &str) -> Result<(), String> {
        Tmux::send_enter(self, target).map_err(|e| clean_stderr(e.stderr()))
    }
}
