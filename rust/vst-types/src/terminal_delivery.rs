//! Pure types for delivering a scheduled message into a Terminal (tmux) agent.
//!
//! Shared by `vst-agents` (the per-CLI plugin decides readiness and capabilities)
//! and `vst-review` (the CLI-agnostic delivery owner). No I/O lives here.

/// What a CLI's input area looks like right now, as judged by its plugin from a
/// [`PaneSnapshot`]. Only `Ready` ever lets a delivery paste.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalReadiness {
    /// At its prompt with an empty input box: safe to paste.
    Ready,
    /// A dialog (trust folder, tool permission, ...) is waiting for the human.
    /// The daemon keeps waiting and never answers it.
    AwaitingApproval,
    /// Busy, starting, text already typed, unrecognised screen, or the probe is
    /// not implemented. Never treated as ready.
    Unknown,
}

/// The visible screen of an agent pane plus the cursor position at the same
/// instant (`capture-pane -p` of the visible screen, no scrollback).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaneSnapshot {
    /// Visible screen text, one `\n`-separated line per screen row.
    pub text: String,
    /// 0-based cursor column on the visible screen.
    pub cursor_x: u16,
    /// 0-based cursor row on the visible screen (indexes `text.lines()`).
    pub cursor_y: u16,
}

/// How a plugin's CLI wants a scheduled message pasted. A plugin returns
/// `Some(caps)` from `terminal_delivery()` only once its readiness probe passes
/// its fixtures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalDeliveryCaps {
    /// Pause between the paste and the Enter that submits it.
    pub settle_ms: u64,
    /// The CLI accepts a multi-line bracketed paste as one message.
    pub multiline_ok: bool,
    /// Paste with `paste-buffer -r` (keep LF as LF instead of converting to CR).
    pub raw_lf: bool,
}

/// Why a scheduled delivery failed. `as_str()` is the persisted `failureKind`
/// column value and the wire value: the single mapping for store, wire and
/// observer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FailureKind {
    TimedOut,
    AgentExited,
    Archived,
    RestartedMidPaste,
    ChannelUnsupported,
    Error,
}

impl FailureKind {
    pub const ALL: [FailureKind; 6] = [
        FailureKind::TimedOut,
        FailureKind::AgentExited,
        FailureKind::Archived,
        FailureKind::RestartedMidPaste,
        FailureKind::ChannelUnsupported,
        FailureKind::Error,
    ];

    /// The snake_case column / wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            FailureKind::TimedOut => "timed_out",
            FailureKind::AgentExited => "agent_exited",
            FailureKind::Archived => "archived",
            FailureKind::RestartedMidPaste => "restarted_mid_paste",
            FailureKind::ChannelUnsupported => "channel_unsupported",
            FailureKind::Error => "error",
        }
    }

    /// Inverse of [`FailureKind::as_str`]; `None` for an unknown value.
    pub fn parse(s: &str) -> Option<FailureKind> {
        FailureKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// The final fate of a terminal delivery row, reported exactly once per outcome
/// to the observer (part of the public surface of `vst-review`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalOutcome {
    /// Pasted and Enter pressed.
    Sent,
    Failed(FailureKind),
    /// The user cancelled it.
    Cancelled,
    /// Back to `scheduled`, still held (restart, reset, channel flip).
    Rearmed,
    /// The session was deleted; the row is gone.
    Gone,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_kind_round_trips_and_uses_snake_case() {
        for k in FailureKind::ALL {
            assert_eq!(FailureKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(
            FailureKind::RestartedMidPaste.as_str(),
            "restarted_mid_paste"
        );
        assert_eq!(FailureKind::parse("nope"), None);
        assert_eq!(FailureKind::parse(""), None);
    }
}
