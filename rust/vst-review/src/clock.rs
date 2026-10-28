//! `YYYY-MM-DDTHH:MM:SSZ` timestamps in the form the store compares as text.
//! (Each crate keeps its own copy of this helper; `vst-review` cannot depend on
//! `vst-lifecycle`.)

use std::time::{SystemTime, UNIX_EPOCH};

/// The current UTC time, second precision.
pub(crate) fn now_iso() -> String {
    format_iso(now_secs())
}

/// Seconds since the Unix epoch.
pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn format_iso(secs: u64) -> String {
    let (y, mo, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian `(year, month, day)`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::format_iso;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(format_iso(1_767_225_599), "2025-12-31T23:59:59Z");
    }
}
