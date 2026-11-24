//! Global cap on simultaneously open transcript databases (3 fds each).
//!
//! A throttle, not a failure source: an open past the cap waits briefly for a
//! permit, then proceeds anyway with a rate-limited warning. Failing would turn
//! a reconnect storm into "Couldn't open this chat's history".

use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_OPEN_TRANSCRIPT_STORES: usize = 32;
pub const STORE_PERMIT_WAIT: Duration = Duration::from_millis(250);
const WARN_EVERY: Duration = Duration::from_secs(60);

pub struct StoreBudget {
    cap: usize,
    wait: Duration,
    count: Mutex<usize>,
    freed: Condvar,
    last_warn: Mutex<Option<Instant>>,
}

/// One open store's claim on the budget; released on drop.
pub struct Permit {
    budget: Arc<StoreBudget>,
}

impl StoreBudget {
    pub fn new(cap: usize, wait: Duration) -> Arc<Self> {
        Arc::new(Self {
            cap,
            wait,
            count: Mutex::new(0),
            freed: Condvar::new(),
            last_warn: Mutex::new(None),
        })
    }

    /// Wait up to `wait` for a free slot, then take one regardless.
    pub fn acquire(self: &Arc<Self>) -> Permit {
        let guard = self.count.lock().unwrap_or_else(|e| e.into_inner());
        let (mut count, timeout) = self
            .freed
            .wait_timeout_while(guard, self.wait, |c| *c >= self.cap)
            .unwrap_or_else(|e| e.into_inner());
        *count += 1;
        if timeout.timed_out() {
            self.warn_over_cap(*count);
        }
        Permit {
            budget: self.clone(),
        }
    }

    /// Stores currently open (permits outstanding).
    pub fn open_count(&self) -> usize {
        *self.count.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn warn_over_cap(&self, open: usize) {
        let mut last = self.last_warn.lock().unwrap_or_else(|e| e.into_inner());
        if last.map_or(true, |t| t.elapsed() >= WARN_EVERY) {
            *last = Some(Instant::now());
            tracing::warn!(open, cap = self.cap, "[transcript] open-store cap exceeded");
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut count = self.budget.count.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        self.budget.freed.notify_one();
    }
}

static GLOBAL: OnceLock<Arc<StoreBudget>> = OnceLock::new();

pub(crate) fn global() -> &'static Arc<StoreBudget> {
    GLOBAL.get_or_init(|| StoreBudget::new(MAX_OPEN_TRANSCRIPT_STORES, STORE_PERMIT_WAIT))
}

/// Gauge: transcript stores currently open in this process.
pub fn open_transcript_stores() -> usize {
    global().open_count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_acquire_waits_then_goes_over_cap() {
        let b = StoreBudget::new(2, Duration::from_millis(200));
        let _p1 = b.acquire();
        let _p2 = b.acquire();
        let b2 = b.clone();
        let t = std::thread::spawn(move || {
            let start = Instant::now();
            let p = b2.acquire();
            (start.elapsed(), b2.open_count(), p)
        });
        let (elapsed, count, _p) = t.join().unwrap();
        assert!(elapsed >= Duration::from_millis(200));
        assert_eq!(count, 3);
    }

    #[test]
    fn a_released_permit_lets_the_waiter_through_early() {
        let b = StoreBudget::new(2, Duration::from_millis(200));
        let p1 = b.acquire();
        let _p2 = b.acquire();
        let b2 = b.clone();
        let t = std::thread::spawn(move || {
            let start = Instant::now();
            let _p = b2.acquire();
            start.elapsed()
        });
        std::thread::sleep(Duration::from_millis(50));
        drop(p1);
        assert!(t.join().unwrap() < Duration::from_millis(190));
    }

    #[test]
    fn count_returns_to_zero_and_double_warn_is_safe() {
        let b = StoreBudget::new(1, Duration::from_millis(5));
        let permits: Vec<_> = (0..3).map(|_| b.acquire()).collect();
        assert_eq!(b.open_count(), 3);
        drop(permits);
        assert_eq!(b.open_count(), 0);
    }
}
