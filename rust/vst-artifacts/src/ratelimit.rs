//! Per-session token bucket for `vst artifact add` (30/min, burst 10; a whole
//! request costs ONE token). Idle entries are evicted so the map stays bounded.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const BURST: f64 = 10.0;
/// 30 per minute.
pub const REFILL_PER_SEC: f64 = 0.5;
pub const IDLE_EVICT: Duration = Duration::from_secs(10 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(60);

struct Bucket {
    tokens: f64,
    last: Instant,
}

struct State {
    buckets: HashMap<String, Bucket>,
    last_sweep: Option<Instant>,
}

pub struct RateLimiter {
    state: Mutex<State>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                buckets: HashMap::new(),
                last_sweep: None,
            }),
        }
    }

    /// Spend one token for `key`; `false` = rate limited.
    pub fn try_acquire(&self, key: &str) -> bool {
        self.try_acquire_at(key, Instant::now())
    }

    /// Clock-injectable form (`now` must not go backwards per key).
    pub fn try_acquire_at(&self, key: &str, now: Instant) -> bool {
        let mut st = self.state.lock().unwrap();
        if st
            .last_sweep
            .map_or(true, |t| now.saturating_duration_since(t) >= SWEEP_EVERY)
        {
            st.buckets
                .retain(|_, b| now.saturating_duration_since(b.last) < IDLE_EVICT);
            st.last_sweep = Some(now);
        }
        let b = st.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: BURST,
            last: now,
        });
        let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * REFILL_PER_SEC).min(BURST);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Number of tracked sessions (test/diagnostic).
    pub fn len(&self) -> usize {
        self.state.lock().unwrap().buckets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
