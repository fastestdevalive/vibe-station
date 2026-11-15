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
    /// The account this window belongs to; absent = the CLI's System login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub cadence_minutes: Option<u32>,
    pub used_pct: Option<f64>,
    pub resets_at: Option<String>,
    pub as_of: String,
    pub status: LimitStatus,
    /// Human label for a window the UI can't name from `window_id` alone
    /// (a model-scoped meter such as "Fable", or a prettified vendor
    /// codename). `None` for the stable claude/codex ids, whose cadence ring
    /// already conveys them. Omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Present only for a dollar-denominated bucket (the vendor sent a numeric
    /// `limit_dollars`); `used_pct` is still that bucket's percent of the cap.
    /// Omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dollars: Option<LimitDollars>,
}

/// Dollar amounts of a dollar-based bucket. Every field is independently
/// optional: vendors have been seen sending only the cap.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitDollars {
    #[serde(default)]
    pub limit: Option<f64>,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
}

/// One probed harness and all of its windows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsResult {
    pub harness: String,
    /// The account this result belongs to; absent = the CLI's System login.
    /// Within one harness the System result is listed FIRST (old clients do
    /// `results.find(harness)` and must get System).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub status: LimitStatus,
    pub message: Option<String>,
    pub as_of: String,
    pub windows: Vec<LimitWindow>,
}

/// A slot reference: which harness + window (+ account) a pinned slot points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSlotRef {
    pub harness: String,
    pub window_id: String,
    /// Absent = the CLI's System login (so persisted keys written before
    /// accounts existed keep pointing at the System login).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
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
            account_id: None,
            cadence_minutes,
            used_pct: None,
            resets_at: None,
            as_of: as_of.into(),
            status,
            label: None,
            dollars: None,
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
            account_id: None,
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
            account_id: None,
            status: LimitStatus::Unsupported,
            message: None,
            as_of: as_of.into(),
            windows: vec![],
        }
    }

    /// Stamp this result (and every window in it) with the account it was
    /// probed for. `None` = the CLI's System login.
    #[must_use]
    pub fn with_account(mut self, account_id: Option<String>) -> Self {
        self.account_id = account_id;
        for w in &mut self.windows {
            w.account_id.clone_from(&self.account_id);
        }
        self
    }
}

impl LimitSlotRef {
    /// A slot on the CLI's System login.
    pub fn new(harness: &str, window_id: &str) -> Self {
        Self {
            harness: harness.into(),
            window_id: window_id.into(),
            account_id: None,
        }
    }

    /// Persisted form `"<harness>/<windowId>"` (System login) or
    /// `"<harness>/<windowId>@<accountId>"`.
    pub fn to_key(&self) -> String {
        match &self.account_id {
            None => format!("{}/{}", self.harness, self.window_id),
            Some(a) => format!("{}/{}@{}", self.harness, self.window_id, a),
        }
    }

    /// Parse a persisted key. The account is split off the LAST `@`; empty
    /// parts and a `/` inside the account are rejected. Keys written before
    /// accounts existed parse as the System login (`account_id: None`).
    pub fn from_key(s: &str) -> Option<Self> {
        let (rest, account) = match s.rsplit_once('@') {
            Some((rest, account)) => (rest, Some(account)),
            None => (s, None),
        };
        let (h, w) = rest.split_once('/')?;
        let account_id = match account {
            None => None,
            Some(a) => {
                if a.is_empty() || a.contains('/') {
                    return None;
                }
                Some(a.to_string())
            }
        };
        (!h.is_empty() && !w.is_empty() && !w.contains('/')).then(|| Self {
            harness: h.into(),
            window_id: w.into(),
            account_id,
        })
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

    #[test]
    fn limit_slot_key_roundtrip_with_account() {
        // Pre-existing (System) key keeps working untouched.
        let system = LimitSlotRef::from_key("claude/five_hour").unwrap();
        assert_eq!(system.harness, "claude");
        assert_eq!(system.window_id, "five_hour");
        assert_eq!(system.account_id, None);
        assert_eq!(system.to_key(), "claude/five_hour");

        let named = LimitSlotRef {
            harness: "claude".into(),
            window_id: "five_hour".into(),
            account_id: Some("acc_1a2b3c4d".into()),
        };
        assert_eq!(named.to_key(), "claude/five_hour@acc_1a2b3c4d");
        assert_eq!(
            LimitSlotRef::from_key("claude/five_hour@acc_1a2b3c4d"),
            Some(named)
        );

        // Rejected shapes.
        assert_eq!(LimitSlotRef::from_key("a/b@"), None, "empty account");
        assert_eq!(LimitSlotRef::from_key("a@/b"), None, "'/' in account");
        assert_eq!(LimitSlotRef::from_key("a//b"), None, "'/' in window");
        assert_eq!(LimitSlotRef::from_key("/b"), None, "empty harness");
        assert_eq!(LimitSlotRef::from_key("a/"), None, "empty window");
        assert_eq!(LimitSlotRef::from_key("a"), None, "no separator");
    }

    #[test]
    fn with_account_stamps_result_and_windows() {
        let r = LimitsResult::failure(
            "claude",
            LimitStatus::NoData,
            "no data",
            "2026-01-01T00:00:00Z",
            &[("five_hour", Some(300))],
        );
        let r = r.with_account(Some("acc_1a2b3c4d".into()));
        assert_eq!(r.account_id.as_deref(), Some("acc_1a2b3c4d"));
        assert_eq!(r.windows.len(), 1);
        assert_eq!(r.windows[0].account_id.as_deref(), Some("acc_1a2b3c4d"));
        let wire = serde_json::to_value(&r).unwrap();
        assert_eq!(wire["accountId"], serde_json::json!("acc_1a2b3c4d"));
        assert_eq!(
            wire["windows"][0]["accountId"],
            serde_json::json!("acc_1a2b3c4d")
        );
        // System result omits the field entirely.
        let system = LimitsResult::unsupported("claude", "2026-01-01T00:00:00Z");
        assert!(serde_json::to_value(&system)
            .unwrap()
            .get("accountId")
            .is_none());
    }
}
