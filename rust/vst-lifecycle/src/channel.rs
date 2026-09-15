//! Channel resolution — ports `services/channel.ts`.
//!
//! Invariants:
//! - `resolve_channel(_, true)` always → `Channel::Json` (json wins)
//! - `resolve_channel(true, false)` → `Channel::Tmux`
//! - `resolve_channel(false, false)` → `Channel::Pty`
//! - `normalize_channel`: stamps a concrete channel; json→useTmux forced false.
//! - Legacy session (no channel, no use_tmux) → Tmux (back-compat with original daemon).

use vst_types::domain::Channel;

/// Resolve a `Channel` from the two boolean axes.
/// `json` takes priority over `use_tmux` (an explicit channel=json session always
/// beats the tmux/pty split).
pub fn resolve_channel(use_tmux: bool, json: bool) -> Channel {
    if json {
        Channel::Json
    } else if use_tmux {
        Channel::Tmux
    } else {
        Channel::Pty
    }
}

/// Derive the effective channel for a session given its stored fields.
/// `explicit_channel` wins when present; otherwise falls back to `use_tmux`.
/// `use_tmux=None` defaults to `true` for back-compat with pre-channel records.
pub fn session_channel(explicit_channel: Option<Channel>, use_tmux: Option<bool>) -> Channel {
    if let Some(ch) = explicit_channel {
        return ch;
    }
    // Legacy: use_tmux absent means the session was created before the
    // channel field existed — treat as tmux.
    resolve_channel(use_tmux.unwrap_or(true), false)
}

/// Stamp a concrete `channel` on a session record that may be missing it, and
/// enforce the json→useTmux=false invariant.
///
/// - If `channel` is already `Some(Json)`, force `use_tmux = Some(false)`.
/// - If `channel` is `None`, derive it from `use_tmux` via `resolve_channel`.
pub fn normalize_channel(channel: &mut Option<Channel>, use_tmux: &mut Option<bool>) {
    match *channel {
        Some(Channel::Json) => {
            *use_tmux = Some(false);
        }
        Some(_) => {}
        None => {
            *channel = Some(resolve_channel(use_tmux.unwrap_or(true), false));
        }
    }
}

/// Compute the `{channel, use_tmux}` pair for a channel transition to `target`.
pub fn channel_transition(target: Channel) -> (Channel, bool) {
    match target {
        Channel::Json => (Channel::Json, false),
        Channel::Tmux => (Channel::Tmux, true),
        Channel::Pty => (Channel::Pty, false),
    }
}
