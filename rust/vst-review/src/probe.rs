//! The ready gate: when is it safe to paste into a Terminal agent?
//!
//! One probe result is never enough: a prompt that is still drawn right after
//! a submit looks Ready for a moment. The gate therefore requires
//! [`READY_POLLS`] consecutive `Ready` readings, and, right after a previous
//! delivery pressed Enter, an extra [`PostEnterGuard`] (a minimum gap plus one
//! capture that differs from the pre-Enter baseline).

use std::hash::{Hash, Hasher};
use std::time::Duration;

use tokio::time::Instant;
use vst_types::terminal_delivery::{PaneSnapshot, TerminalReadiness};

/// Consecutive `Ready` readings needed before a paste.
pub const READY_POLLS: u8 = 2;

/// Minimum time since the previous Enter to the same agent before the next
/// delivery may count `Ready` readings.
pub const MIN_GAP_AFTER_ENTER: Duration = Duration::from_secs(3);

/// What the previous delivery to this session left behind (Decision 8).
#[derive(Clone, Copy, Debug)]
pub struct PostEnterGuard {
    /// When Enter was pressed.
    pub enter_at: Instant,
    /// [`pane_hash`] of the capture taken after paste + settle, immediately
    /// before Enter: the text was visible and unsubmitted.
    pub baseline: u64,
    /// A capture differing from `baseline` has been seen.
    pub changed: bool,
}

/// Stable-within-process fingerprint of a pane capture (text and cursor).
pub fn pane_hash(snapshot: &PaneSnapshot) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    snapshot.text.hash(&mut h);
    snapshot.cursor_x.hash(&mut h);
    snapshot.cursor_y.hash(&mut h);
    h.finish()
}

/// Decides, poll by poll, when the agent is provably at its prompt.
#[derive(Debug)]
pub struct ReadyGate {
    consecutive: u8,
    guard: Option<PostEnterGuard>,
}

impl ReadyGate {
    /// A gate with an optional post-Enter guard from the previous delivery.
    pub fn new(guard: Option<PostEnterGuard>) -> Self {
        Self {
            consecutive: 0,
            guard,
        }
    }

    /// The guard with its current `changed` flag (to carry to the next job).
    pub fn guard(&self) -> Option<PostEnterGuard> {
        self.guard
    }

    /// Feed one poll. `true` = paste now. Anything but `Ready` (including
    /// `AwaitingApproval`) resets the streak; `Ready` readings do not count
    /// while the post-Enter guard is unsatisfied. `in_mode` (copy-mode) is not
    /// an input: a scrolled pane still reads fine.
    pub fn observe(&mut self, now: Instant, readiness: TerminalReadiness, pane_hash: u64) -> bool {
        let mut guard_open = true;
        if let Some(g) = self.guard.as_mut() {
            if pane_hash != g.baseline {
                g.changed = true;
            }
            guard_open =
                g.changed && now.saturating_duration_since(g.enter_at) >= MIN_GAP_AFTER_ENTER;
        }
        if readiness == TerminalReadiness::Ready && guard_open {
            self.consecutive = self.consecutive.saturating_add(1);
        } else {
            self.consecutive = 0;
        }
        self.consecutive >= READY_POLLS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use TerminalReadiness::{AwaitingApproval, Ready, Unknown};

    fn now() -> Instant {
        Instant::now()
    }

    #[tokio::test(start_paused = true)]
    async fn needs_two_consecutive_ready() {
        let mut g = ReadyGate::new(None);
        assert!(!g.observe(now(), Ready, 1));
        assert!(!g.observe(now(), Unknown, 1));
        assert!(!g.observe(now(), Ready, 1));
        assert!(g.observe(now(), Ready, 1));
    }

    #[tokio::test(start_paused = true)]
    async fn awaiting_approval_resets_the_streak() {
        let mut g = ReadyGate::new(None);
        assert!(!g.observe(now(), Ready, 1));
        assert!(!g.observe(now(), AwaitingApproval, 1));
        assert!(!g.observe(now(), Ready, 1));
        assert!(g.observe(now(), Ready, 1));
    }

    #[tokio::test(start_paused = true)]
    async fn guard_needs_gap_and_a_changed_capture() {
        let guard = PostEnterGuard {
            enter_at: now(),
            baseline: 7,
            changed: false,
        };
        let mut g = ReadyGate::new(Some(guard));
        // Unchanged pane, gap elapsed: still closed.
        tokio::time::advance(MIN_GAP_AFTER_ENTER + Duration::from_millis(1)).await;
        assert!(!g.observe(now(), Ready, 7));
        assert!(!g.observe(now(), Ready, 7));
        // One differing capture opens it; the streak starts counting then.
        assert!(!g.observe(now(), Ready, 8));
        assert!(g.observe(now(), Ready, 7));
        assert!(g.guard().unwrap().changed);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_blocks_during_the_minimum_gap_even_when_changed() {
        let guard = PostEnterGuard {
            enter_at: now(),
            baseline: 7,
            changed: false,
        };
        let mut g = ReadyGate::new(Some(guard));
        assert!(!g.observe(now(), Ready, 8));
        assert!(!g.observe(now(), Ready, 8));
        tokio::time::advance(MIN_GAP_AFTER_ENTER).await;
        assert!(!g.observe(now(), Ready, 8));
        assert!(g.observe(now(), Ready, 8));
    }

    #[test]
    fn pane_hash_covers_text_and_cursor() {
        let a = PaneSnapshot {
            text: "x".into(),
            cursor_x: 1,
            cursor_y: 2,
        };
        let mut b = a.clone();
        assert_eq!(pane_hash(&a), pane_hash(&b));
        b.cursor_x = 2;
        assert_ne!(pane_hash(&a), pane_hash(&b));
        b = a.clone();
        b.text = "y".into();
        assert_ne!(pane_hash(&a), pane_hash(&b));
    }
}
