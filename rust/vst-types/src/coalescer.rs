//! `Coalescer<K>` — a pure, timer-free dirty-set state machine shared by the
//! PR poller (`vst-lifecycle`) and the diffstat poller (`vst-diffstat`).
//!
//! The coalescer owns **no I/O and no timers**: every method takes an explicit
//! `now: std::time::Instant`, so a driver loop (one per poller) is the only
//! thing that sleeps. That keeps the whole state machine unit-testable with
//! fake instants.
//!
//! ## Clock rule
//!
//! This module uses `std::time::Instant`. An async driver computes
//! `tokio::time::Instant::now().into_std()` and passes that in, so paused
//! tokio time (`tokio::time::pause`) also drives the coalescer.
//!
//! ## Semantics
//!
//! - [`Coalescer::mark_dirty`] schedules a key at
//!   `max(now + debounce, last_start + min_spacing)`, bounded above by
//!   `first_dirty_at + max_wait` so a continuous stream of events cannot
//!   starve a key forever. A shorter per-mark debounce (the "focus hint") can
//!   pull an already-dirty key's due time earlier.
//! - Marking a key that is **in flight** only sets the rerun flag — the
//!   in-flight run keeps its place, and [`Coalescer::finish`] guarantees
//!   exactly one trailing run.
//! - [`Coalescer::take_ready`] hands out only keys that are dirty, not in
//!   flight, and due, ordered by priority (descending) then due time
//!   (ascending); taking a key marks it in flight.
//! - [`Coalescer::finish`] clears the in-flight flag, and either re-arms the
//!   key for the trailing run or leaves it settled. The key's `last_start` is
//!   kept after it settles so the min-spacing floor still applies to the next
//!   mark.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Timing configuration for a [`Coalescer`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoalescerConfig {
    /// Default quiet period after the most recent mark before a key runs.
    pub debounce: Duration,
    /// Minimum time between the START of two consecutive runs of one key.
    pub min_spacing: Duration,
    /// Upper bound on how long a continuously re-marked key may stay dirty.
    pub max_wait: Duration,
}

/// Per-mark overrides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarkOpts {
    /// Override the coalescer's default debounce for this mark (e.g. a client
    /// focus hint that should react faster).
    pub debounce: Option<Duration>,
    /// Higher priorities are handed out first by [`Coalescer::take_ready`].
    /// A mark never lowers an existing key's priority.
    pub priority: u64,
}

#[derive(Clone, Debug, Default)]
struct KeyState {
    dirty: bool,
    in_flight: bool,
    rerun: bool,
    due: Option<Instant>,
    priority: u64,
    last_start: Option<Instant>,
    first_dirty_at: Option<Instant>,
}

/// Pure dirty-set / in-flight / debounce / min-spacing state machine.
///
/// `K` is any hashable key (a worktree id for the diffstat poller, `()` for the
/// PR poller's single global key). All timing is injected via `now`, so this
/// type performs no I/O and needs no runtime.
#[derive(Clone, Debug)]
pub struct Coalescer<K> {
    config: CoalescerConfig,
    keys: HashMap<K, KeyState>,
}

impl<K: Eq + Hash + Clone> Coalescer<K> {
    /// Create an empty coalescer with the given timing configuration.
    #[must_use]
    pub fn new(config: CoalescerConfig) -> Self {
        Self {
            config,
            keys: HashMap::new(),
        }
    }

    /// The configuration this coalescer was built with.
    #[must_use]
    pub fn config(&self) -> CoalescerConfig {
        self.config
    }

    /// Mark `key` dirty at `now`.
    ///
    /// A key that is currently in flight is not re-scheduled: it only gets the
    /// rerun flag, which [`Self::finish`] turns into exactly one trailing run.
    /// A key that is already dirty keeps its `first_dirty_at` (so `max_wait`
    /// still bounds it) and gets a due time of
    /// `max(last_start + min_spacing, min(now + debounce, first_dirty_at + max_wait))`.
    /// Priority is raised to the higher of the old and the new value.
    pub fn mark_dirty(&mut self, key: K, now: Instant, opts: MarkOpts) {
        let debounce = opts.debounce.unwrap_or(self.config.debounce);
        let max_wait = self.config.max_wait;
        let min_spacing = self.config.min_spacing;
        let entry = self.keys.entry(key).or_default();
        entry.priority = entry.priority.max(opts.priority);
        if entry.in_flight {
            entry.rerun = true;
            return;
        }
        if !entry.dirty {
            entry.dirty = true;
            entry.first_dirty_at = Some(now);
        }
        let first_dirty_at = entry.first_dirty_at.unwrap_or(now);
        let mut due = (now + debounce).min(first_dirty_at + max_wait);
        if let Some(last_start) = entry.last_start {
            due = due.max(last_start + min_spacing);
        }
        entry.due = Some(due);
    }

    /// The earliest due time among dirty, not-in-flight keys, or `None` when
    /// nothing is waiting. A driver sleeps until this instant (or until it is
    /// notified of a new mark, whichever comes first).
    #[must_use]
    pub fn next_due(&self) -> Option<Instant> {
        self.keys
            .values()
            .filter(|e| e.dirty && !e.in_flight)
            .filter_map(|e| e.due)
            .min()
    }

    /// Take every key that is dirty, not in flight, and due at `now`, ordered
    /// by priority (descending) then due time (ascending). Each taken key is
    /// marked in flight; callers must call [`Self::finish`] when its run ends.
    ///
    /// Keys with identical priority and due time have no defined relative
    /// order. Taking a key resets its priority to 0 (see
    /// [`Self::take_ready_limited`]).
    pub fn take_ready(&mut self, now: Instant) -> Vec<K> {
        self.take_ready_limited(now, usize::MAX)
    }

    /// Like [`Self::take_ready`], but hands out at most `limit` keys (the
    /// highest-priority, earliest-due ones). Keys left behind stay dirty and
    /// untouched, so a driver with a bounded worker pool never over-takes.
    /// A taken key's priority is reset to 0: priority only describes one
    /// pending period, so a worktree focused once does not outrank later work
    /// forever. A mark made while the key is in flight raises it again for the
    /// trailing run.
    pub fn take_ready_limited(&mut self, now: Instant, limit: usize) -> Vec<K> {
        let mut ready: Vec<(u64, Instant, K)> = self
            .keys
            .iter()
            .filter(|(_, e)| e.dirty && !e.in_flight && e.due.is_some_and(|d| d <= now))
            .map(|(k, e)| {
                // `dirty` implies `due` is set; fall back to `now` defensively.
                (e.priority, e.due.unwrap_or(now), k.clone())
            })
            .collect();
        // Highest priority first, then earliest due first.
        ready.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        ready.truncate(limit);
        let keys: Vec<K> = ready.into_iter().map(|(_, _, k)| k).collect();
        for key in &keys {
            if let Some(e) = self.keys.get_mut(key) {
                e.dirty = false;
                e.in_flight = true;
                e.rerun = false;
                e.last_start = Some(now);
                e.first_dirty_at = None;
                e.due = None;
                e.priority = 0;
            }
        }
        keys
    }

    /// Mark `key`'s in-flight run finished at `now`.
    ///
    /// If the key was re-marked while in flight, it becomes dirty again with
    /// `due = max(now, last_start + min_spacing)` — one guaranteed trailing
    /// run, still respecting the spacing floor. Otherwise the key settles.
    pub fn finish(&mut self, key: &K, now: Instant) {
        let min_spacing = self.config.min_spacing;
        let Some(entry) = self.keys.get_mut(key) else {
            return;
        };
        if !entry.in_flight {
            return;
        }
        entry.in_flight = false;
        if entry.rerun {
            entry.rerun = false;
            entry.dirty = true;
            entry.first_dirty_at = Some(now);
            let spacing_floor = entry.last_start.map_or(now, |last| last + min_spacing);
            entry.due = Some(now.max(spacing_floor));
        } else {
            entry.due = None;
        }
    }

    /// Forget everything about `key` (used for eviction when a worktree or
    /// project disappears).
    pub fn remove(&mut self, key: &K) {
        self.keys.remove(key);
    }

    /// Whether `key` has pending work: dirty, in flight, or awaiting a trailing
    /// run. A settled key that only retains its `last_start` (for the spacing
    /// floor) is NOT reported as contained.
    #[must_use]
    pub fn contains(&self, key: &K) -> bool {
        self.keys
            .get(key)
            .is_some_and(|e| e.dirty || e.in_flight || e.rerun)
    }
}

#[cfg(test)]
mod tests {
    use super::{Coalescer, CoalescerConfig, MarkOpts};
    use std::time::{Duration, Instant};

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn config() -> CoalescerConfig {
        CoalescerConfig {
            debounce: secs(2),
            min_spacing: secs(5),
            max_wait: secs(5),
        }
    }

    fn at(t0: Instant, secs_after: u64) -> Instant {
        t0 + secs(secs_after)
    }

    fn hint() -> MarkOpts {
        MarkOpts {
            debounce: Some(secs(1)),
            priority: 0,
        }
    }

    fn mark() -> MarkOpts {
        MarkOpts::default()
    }

    #[test]
    fn debounce_delays_the_run() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        assert_eq!(c.next_due(), Some(at(t0, 2)));
        assert!(c.take_ready(t0 + Duration::from_millis(1_900)).is_empty());
        assert_eq!(c.take_ready(at(t0, 2)), vec!["a"]);
    }

    #[test]
    fn continuous_marks_do_not_starve_a_key() {
        // Marks every second for 60 seconds: the key must run within `max_wait`.
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        let mut first_run = None;
        for s in 0..60u64 {
            let now = at(t0, s);
            c.mark_dirty("a", now, mark());
            let ready = c.take_ready(now);
            if !ready.is_empty() {
                assert_eq!(ready, vec!["a"]);
                c.finish(&"a", now);
                first_run.get_or_insert(s);
            }
        }
        let first_run = first_run.expect("a continuously marked key must eventually run");
        assert!(
            first_run <= 5,
            "first ran at {first_run}s, expected within max_wait (5s)"
        );
    }

    #[test]
    fn hint_debounce_pulls_an_already_dirty_key_earlier() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        assert_eq!(c.next_due(), Some(at(t0, 2)));
        // A 1 s hint half a second later beats the original 2 s debounce.
        c.mark_dirty("a", t0 + Duration::from_millis(500), hint());
        assert_eq!(c.next_due(), Some(t0 + Duration::from_millis(1_500)));
        assert!(c.take_ready(t0 + Duration::from_millis(1_499)).is_empty());
        assert_eq!(c.take_ready(t0 + Duration::from_millis(1_500)), vec!["a"]);
    }

    #[test]
    fn spacing_floor_applies_after_a_run_finishes() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        assert_eq!(c.take_ready(at(t0, 2)), vec!["a"]);
        c.finish(&"a", at(t0, 2));
        // Re-marked right after finishing: debounce 0 would fire immediately,
        // but the 5 s spacing floor from the last start wins.
        c.mark_dirty(
            "a",
            at(t0, 2),
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 0,
            },
        );
        assert_eq!(c.next_due(), Some(at(t0, 7)));
        assert!(c.take_ready(at(t0, 6)).is_empty());
        assert_eq!(c.take_ready(at(t0, 7)), vec!["a"]);
    }

    #[test]
    fn mark_during_flight_yields_exactly_one_trailing_run() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        assert_eq!(c.take_ready(at(t0, 2)), vec!["a"]);
        // Two marks while in flight collapse into one rerun.
        c.mark_dirty("a", at(t0, 3), mark());
        c.mark_dirty("a", at(t0, 4), mark());
        // An in-flight key is never handed out again.
        assert!(c.take_ready(at(t0, 6)).is_empty());
        assert_eq!(c.next_due(), None);
        c.finish(&"a", at(t0, 6));
        // One trailing run, spaced 5 s from the previous start.
        assert_eq!(c.next_due(), Some(at(t0, 7)));
        assert_eq!(c.take_ready(at(t0, 7)), vec!["a"]);
        c.finish(&"a", at(t0, 8));
        assert!(c.take_ready(at(t0, 100)).is_empty());
        assert!(!c.contains(&"a"));
    }

    #[test]
    fn many_marks_collapse_into_one_run() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        for i in 0..10 {
            c.mark_dirty("a", t0 + Duration::from_millis(i * 100), mark());
        }
        // The debounce restarts on the LAST mark (t0 + 0.9 s).
        assert_eq!(c.take_ready(at(t0, 2)).len(), 0);
        assert_eq!(c.take_ready(t0 + Duration::from_millis(2_900)).len(), 1);
    }

    #[test]
    fn take_ready_orders_by_priority_then_due() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty(
            "low",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 1,
            },
        );
        c.mark_dirty(
            "high",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 10,
            },
        );
        c.mark_dirty(
            "mid-early",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 5,
            },
        );
        c.mark_dirty(
            "mid-late",
            t0,
            MarkOpts {
                debounce: Some(secs(1)),
                priority: 5,
            },
        );
        assert_eq!(
            c.take_ready(at(t0, 1)),
            vec!["high", "mid-early", "mid-late", "low"]
        );
    }

    #[test]
    fn mark_never_lowers_priority() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty(
            "a",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 9,
            },
        );
        c.mark_dirty("a", t0, mark());
        c.mark_dirty(
            "b",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 1,
            },
        );
        // `a`'s re-mark with the default 2 s debounce pushed its due later than
        // `b`'s, but its priority was NOT lowered, so it still comes first.
        assert_eq!(c.take_ready(at(t0, 2)), vec!["a", "b"]);
    }

    fn now_opts(priority: u64) -> MarkOpts {
        MarkOpts {
            debounce: Some(Duration::ZERO),
            priority,
        }
    }

    #[test]
    fn take_ready_limited_takes_the_best_and_leaves_the_rest() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, now_opts(1));
        c.mark_dirty("b", t0, now_opts(3));
        c.mark_dirty("c", t0, now_opts(2));
        assert_eq!(c.take_ready_limited(t0, 1), vec!["b"]);
        assert!(c.contains(&"a") && c.contains(&"c"));
        assert_eq!(c.take_ready_limited(t0, 5), vec!["c", "a"]);
    }

    #[test]
    fn take_ready_limited_zero_changes_nothing() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, now_opts(1));
        assert!(c.take_ready_limited(t0, 0).is_empty());
        assert_eq!(c.next_due(), Some(t0));
        assert_eq!(c.take_ready(t0), vec!["a"]);
    }

    #[test]
    fn priority_resets_after_a_key_is_taken() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("old", t0, now_opts(u64::MAX));
        assert_eq!(c.take_ready(t0), vec!["old"]);
        c.finish(&"old", t0);
        let t1 = at(t0, 10);
        c.mark_dirty("old", t1, now_opts(0));
        c.mark_dirty("new", t1, now_opts(5));
        assert_eq!(c.take_ready(t1), vec!["new", "old"]);
    }

    #[test]
    fn mark_during_flight_keeps_its_priority_for_the_rerun() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, now_opts(1));
        assert_eq!(c.take_ready(t0), vec!["a"]);
        c.mark_dirty("a", t0, now_opts(7));
        c.finish(&"a", t0);
        c.mark_dirty("b", at(t0, 5), now_opts(3));
        assert_eq!(c.take_ready(at(t0, 5)), vec!["a", "b"]);
    }

    #[test]
    fn remove_forgets_the_key() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        assert!(c.contains(&"a"));
        c.remove(&"a");
        assert!(!c.contains(&"a"));
        assert_eq!(c.next_due(), None);
        assert!(c.take_ready(at(t0, 10)).is_empty());
    }

    #[test]
    fn next_due_ignores_in_flight_keys() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty(
            "inflight",
            t0,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: 0,
            },
        );
        assert_eq!(c.take_ready(t0), vec!["inflight"]);
        c.mark_dirty("waiting", t0, mark());
        assert_eq!(c.next_due(), Some(at(t0, 2)));
    }

    #[test]
    fn finish_on_a_settled_key_is_a_no_op() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(config());
        c.mark_dirty("a", t0, mark());
        c.finish(&"a", t0);
        assert_eq!(c.next_due(), Some(at(t0, 2)));
        c.finish(&"unknown", t0);
    }
}
