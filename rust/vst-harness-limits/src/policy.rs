//! Pure policy helpers for the harness-limits scheduler — no I/O, unit-tested.
//!
//! All timings, debounce/cooldown checks, and the turn-finished predicate
//! live here so they can be reasoned about and tested without a runtime.

use std::time::{Duration, Instant};

use vst_types::LifecycleState;

/// Scheduler timing knobs. All durations; a test constructs its own with
/// millisecond values.
#[derive(Clone, Debug)]
pub struct LimitsTiming {
    pub interval: Duration,          // 300 s
    pub stale_after: Duration,       // 300 s (client-fetch refresh threshold)
    pub turn_debounce: Duration,     // 60 s
    pub manual_cooldown: Duration,   // 30 s
    pub backoff_initial: Duration,   // 30 s
    pub backoff_cap: Duration,       // 300 s
    pub rebroadcast_after: Duration, // 900 s
    pub probe_timeout: Duration,     // 25 s (must exceed the plugins' own 20 s)
}

impl Default for LimitsTiming {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(300),
            stale_after: Duration::from_secs(300),
            turn_debounce: Duration::from_secs(60),
            manual_cooldown: Duration::from_secs(30),
            backoff_initial: Duration::from_secs(30),
            backoff_cap: Duration::from_secs(300),
            rebroadcast_after: Duration::from_secs(900),
            probe_timeout: Duration::from_secs(25),
        }
    }
}

/// `min(cap, initial * 2^(fail_count-1))`; `fail_count` 0 => `Duration::ZERO`.
pub fn backoff_delay(fail_count: u32, initial: Duration, cap: Duration) -> Duration {
    if fail_count == 0 {
        return Duration::ZERO;
    }
    let shift = fail_count.saturating_sub(1);
    let doubled = initial.saturating_mul(1u32 << shift.min(30));
    if doubled > cap {
        cap
    } else {
        doubled
    }
}

/// True when a session transitioned out of `Working` into a finished-like
/// state — the "agent turn finished" trigger for a per-harness probe.
pub fn is_turn_finished(prev: Option<LifecycleState>, new: LifecycleState) -> bool {
    matches!(prev, Some(LifecycleState::Working))
        && matches!(
            new,
            LifecycleState::Idle
                | LifecycleState::WaitingForHuman
                | LifecycleState::Done
                | LifecycleState::Exited
        )
}

/// `None` last probe is always stale.
pub fn is_stale(last_probe: Option<Instant>, now: Instant, stale_after: Duration) -> bool {
    last_probe.map_or(true, |t| now.duration_since(t) >= stale_after)
}

/// `Some(remaining)` while inside the cooldown window, `None` once elapsed.
pub fn cooldown_remaining(
    last: Option<Instant>,
    now: Instant,
    cooldown: Duration,
) -> Option<Duration> {
    let last = last?;
    let elapsed = now.duration_since(last);
    if elapsed >= cooldown {
        None
    } else {
        Some(cooldown - elapsed)
    }
}

/// True if enough time has passed since the last occurrence for a debounced
/// trigger to fire. A `None` last time always passes.
pub fn debounce_ok(last: Option<Instant>, now: Instant, debounce: Duration) -> bool {
    last.map_or(true, |t| now.duration_since(t) >= debounce)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn backoff_delay_doubles_then_caps() {
        let init = secs(30);
        let cap = secs(300);
        let cases = [
            (0u32, 0u64),
            (1, 30),
            (2, 60),
            (3, 120),
            (4, 240),
            (5, 300),
            (6, 300),
        ];
        for (fail_count, expect) in cases {
            assert_eq!(
                backoff_delay(fail_count, init, cap),
                secs(expect),
                "fail_count={fail_count}"
            );
        }
    }

    #[test]
    fn is_turn_finished_only_from_working() {
        assert!(is_turn_finished(
            Some(LifecycleState::Working),
            LifecycleState::Idle
        ));
        assert!(is_turn_finished(
            Some(LifecycleState::Working),
            LifecycleState::WaitingForHuman
        ));
        assert!(is_turn_finished(
            Some(LifecycleState::Working),
            LifecycleState::Done
        ));
        assert!(is_turn_finished(
            Some(LifecycleState::Working),
            LifecycleState::Exited
        ));

        assert!(!is_turn_finished(
            Some(LifecycleState::NotStarted),
            LifecycleState::WaitingForHuman
        ));
        assert!(!is_turn_finished(None, LifecycleState::Idle));
        assert!(!is_turn_finished(
            Some(LifecycleState::Working),
            LifecycleState::Working
        ));
    }

    #[test]
    fn cooldown_remaining_inside_and_outside() {
        let cd = secs(30);
        let start = Instant::now();
        // Inside.
        assert!(cooldown_remaining(Some(start), start + secs(10), cd).is_some());
        // At the boundary: elapsed == cooldown => None.
        assert!(cooldown_remaining(Some(start), start + secs(30), cd).is_none());
        // Past.
        assert!(cooldown_remaining(Some(start), start + secs(40), cd).is_none());
        // Never ran => None.
        assert!(cooldown_remaining(None, start, cd).is_none());
    }

    #[test]
    fn debounce_ok_boundaries() {
        let db = secs(60);
        let start = Instant::now();
        // Never ran => ok.
        assert!(debounce_ok(None, start, db));
        // Too soon => not ok.
        assert!(!debounce_ok(Some(start), start + secs(59), db));
        // At the boundary => ok.
        assert!(debounce_ok(Some(start), start + secs(60), db));
        // Past => ok.
        assert!(debounce_ok(Some(start), start + secs(61), db));
    }
}
