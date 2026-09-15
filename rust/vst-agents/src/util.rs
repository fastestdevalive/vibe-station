//! Small shared helpers for the 04c port: UUID v4 minting and ISO8601 UTC
//! timestamps matching the daemon's `randomUUID()` / `new Date().toISOString()`
//! wire format (`YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC, 3-digit millis, `Z` suffix).

/// A fresh UUID v4 (matches Node's `crypto.randomUUID()`).
pub fn new_uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `new Date().toISOString()` — current UTC time, ISO8601 with milliseconds.
pub fn now_iso_8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `new Date(ms).toISOString()` — the given epoch-millis as ISO8601 with millis.
pub fn ms_to_iso_8601(ms: i64) -> String {
    let dt = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_else(|| chrono::Utc::now());
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
