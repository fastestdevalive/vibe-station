//! Harness usage limits — the wire contract for the limits feature.
//!
//! Owns the `LimitStatus`/`LimitWindow`/`LimitsResult`/`LimitSlotRef`/
//! `LimitsSnapshot`/`LimitsRefreshResult`/`PutLimitSlotsBody` shapes shared
//! by the daemon's harness-limits scheduler (REST + WS) and the web-ui.
//! Mirrors the `web-ui/src/api/types.ts` limits block.

use serde::{Deserialize, Serialize};

/// Per-window / per-harness status. `unsupported` is internal: it is never
/// surfaced in a snapshot (the scheduler hides those harnesses entirely).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitStatus {
    Ok,
    NotInstalled,
    SignedOut,
    NoPlanLimits,
    NoData,
    Error,
    Unsupported,
}

/// A single usage window for one harness.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub harness: String,
    pub window_id: String,
    pub cadence_minutes: Option<u32>,
    pub used_pct: Option<f64>,
    pub resets_at: Option<String>,
    pub as_of: String,
    pub status: LimitStatus,
}

/// One probed harness and all of its windows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsResult {
    pub harness: String,
    pub status: LimitStatus,
    pub message: Option<String>,
    pub as_of: String,
    pub windows: Vec<LimitWindow>,
}

/// A slot reference: which harness + window a pinned slot points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSlotRef {
    pub harness: String,
    pub window_id: String,
}

/// The full limits snapshot — REST + WS payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsSnapshot {
    pub host: String,
    pub slots: [LimitSlotRef; 2],
    pub harnesses: Vec<LimitsResult>,
}

/// `POST /api/limits/refresh` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsRefreshResult {
    pub started: bool,
    pub retry_after_secs: Option<u64>,
    pub snapshot: LimitsSnapshot,
}

/// `PUT /api/limits/slots` request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutLimitSlotsBody {
    pub slots: Vec<LimitSlotRef>,
}

impl LimitWindow {
    pub fn placeholder(
        harness: &str,
        window_id: &str,
        cadence_minutes: Option<u32>,
        status: LimitStatus,
        as_of: &str,
    ) -> Self {
        Self {
            harness: harness.into(),
            window_id: window_id.into(),
            cadence_minutes,
            used_pct: None,
            resets_at: None,
            as_of: as_of.into(),
            status,
        }
    }
}

impl LimitsResult {
    /// Failure result with one `used_pct: None` placeholder window per
    /// `(window_id, cadence)`.
    pub fn failure(
        harness: &str,
        status: LimitStatus,
        message: impl Into<String>,
        as_of: &str,
        windows: &[(&str, Option<u32>)],
    ) -> Self {
        Self {
            harness: harness.into(),
            status,
            message: Some(cap_message(message.into())),
            as_of: as_of.into(),
            windows: windows
                .iter()
                .map(|(id, c)| LimitWindow::placeholder(harness, id, *c, status, as_of))
                .collect(),
        }
    }

    pub fn unsupported(harness: &str, as_of: &str) -> Self {
        Self {
            harness: harness.into(),
            status: LimitStatus::Unsupported,
            message: None,
            as_of: as_of.into(),
            windows: vec![],
        }
    }
}

impl LimitSlotRef {
    pub fn new(harness: &str, window_id: &str) -> Self {
        Self {
            harness: harness.into(),
            window_id: window_id.into(),
        }
    }

    /// Persisted form `"<harness>/<windowId>"`.
    pub fn to_key(&self) -> String {
        format!("{}/{}", self.harness, self.window_id)
    }

    pub fn from_key(s: &str) -> Option<Self> {
        let (h, w) = s.split_once('/')?;
        (!h.is_empty() && !w.is_empty() && !w.contains('/')).then(|| Self::new(h, w))
    }
}

/// The default two slots when none are pinned: claude's two plan windows.
pub fn default_slots() -> [LimitSlotRef; 2] {
    [
        LimitSlotRef::new("claude", "five_hour"),
        LimitSlotRef::new("claude", "seven_day"),
    ]
}

/// Longest vendor/diagnostic text we put on the wire (chars).
const MAX_MESSAGE_CHARS: usize = 200;

/// Cap a free-form message so unbounded vendor error text never reaches clients.
fn cap_message(message: String) -> String {
    if message.chars().count() <= MAX_MESSAGE_CHARS {
        return message;
    }
    let mut out: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod message_cap_tests {
    use super::*;

    #[test]
    fn failure_message_is_capped() {
        let long = "x".repeat(5_000);
        let r = LimitsResult::failure(
            "claude",
            LimitStatus::Error,
            long,
            "2026-01-01T00:00:00Z",
            &[],
        );
        let msg = r.message.unwrap();
        assert_eq!(msg.chars().count(), 201);
        assert!(msg.ends_with('…'));
    }

    #[test]
    fn short_failure_message_is_untouched() {
        let r = LimitsResult::failure(
            "claude",
            LimitStatus::Error,
            "boom",
            "2026-01-01T00:00:00Z",
            &[],
        );
        assert_eq!(r.message.as_deref(), Some("boom"));
    }
}
