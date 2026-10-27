//! Registry clock + ISO-8601 helpers.

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::time::Instant;

/// `SystemTime` at construction, advanced by tokio's clock (pausable in tests).
pub(crate) struct Clock {
    base_unix_ms: i64,
    base: Instant,
}

impl Clock {
    pub(crate) fn new() -> Self {
        let base_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        Self {
            base_unix_ms,
            base: Instant::now(),
        }
    }

    /// Wall clock, except that it never lags the tokio-advanced time. tokio's
    /// `Instant` does not advance while the machine sleeps, so
    /// `base + elapsed` alone drifts behind event `ts` values; the wall clock
    /// wins in production, and paused-time tests advance via the second term.
    pub(crate) fn now_ms(&self) -> i64 {
        let elapsed = Instant::now().saturating_duration_since(self.base);
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        merge_ms(wall, self.base_unix_ms, elapsed.as_millis())
    }
}

/// `max(wall, base + elapsed)` in unix ms.
fn merge_ms(wall: i64, base_unix_ms: i64, elapsed_ms: u128) -> i64 {
    wall.max(base_unix_ms.saturating_add(i64::try_from(elapsed_ms).unwrap_or(i64::MAX)))
}

#[cfg(test)]
mod tests {
    use super::merge_ms;

    #[test]
    fn wall_clock_wins_after_sleep_and_tokio_time_wins_when_paused() {
        // Machine slept 1h: tokio elapsed is only 10s, wall moved on.
        assert_eq!(merge_ms(3_600_000, 0, 10_000), 3_600_000);
        // Paused-time test: wall barely moved, tokio elapsed advanced.
        assert_eq!(merge_ms(5, 0, 10_000), 10_000);
    }
}

/// Parse an RFC 3339 timestamp to unix ms.
pub(crate) fn parse_ts(ts: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Format unix ms as `YYYY-MM-DDTHH:MM:SS.mmmZ` (the daemon's timestamp shape).
#[must_use]
pub fn format_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
