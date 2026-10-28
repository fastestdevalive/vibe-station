//! 2.T10: rate limiter.

use std::time::{Duration, Instant};

use vst_artifacts::ratelimit::{RateLimiter, BURST, IDLE_EVICT};

#[test]
fn burst_then_limited_then_refill() {
    let rl = RateLimiter::new();
    let t0 = Instant::now();
    for i in 0..BURST as usize {
        assert!(rl.try_acquire_at("s", t0), "token {i}");
    }
    assert!(!rl.try_acquire_at("s", t0));
    // 30 per minute: one token every 2 s.
    assert!(!rl.try_acquire_at("s", t0 + Duration::from_millis(1900)));
    assert!(rl.try_acquire_at("s", t0 + Duration::from_secs(2)));
    // Other sessions are independent.
    assert!(rl.try_acquire_at("other", t0));
}

#[test]
fn refill_is_capped_at_the_burst() {
    let rl = RateLimiter::new();
    let t0 = Instant::now();
    assert!(rl.try_acquire_at("s", t0));
    let later = t0 + Duration::from_secs(3600);
    for _ in 0..BURST as usize {
        assert!(rl.try_acquire_at("s", later));
    }
    assert!(!rl.try_acquire_at("s", later));
}

#[test]
fn idle_entries_are_evicted() {
    let rl = RateLimiter::new();
    let t0 = Instant::now();
    for i in 0..5 {
        assert!(rl.try_acquire_at(&format!("s{i}"), t0));
    }
    assert_eq!(rl.len(), 5);
    let later = t0 + IDLE_EVICT + Duration::from_secs(61);
    assert!(rl.try_acquire_at("fresh", later));
    assert_eq!(rl.len(), 1);
}
