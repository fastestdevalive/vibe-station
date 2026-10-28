//! Merges the per-update fragments of an ACP tool call into one
//! [`MergedToolCall`] and reports it exactly once, on its terminal status
//! (`Completed` or `Failed`; the call keeps its final status).
//!
//! ACP delivers a tool call as a `tool_call` followed by many
//! `tool_call_update`s. The path of a claude `Write`/`Edit` only appears in a
//! mid-call update (the `completed` update carries none), and a codex
//! `apply_patch` carries everything in its first event. Neither ordering may
//! be assumed, so effects are computed from the merged call when it completes
//! (artifact capture, Decision 3).

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use vst_types::{
    AcpToolKind, NormalizedEvent, NormalizedEventKind, ToolDiff, ToolLocation, ToolStatus,
};

/// Most open (not yet terminal) calls kept; the oldest is dropped beyond this.
pub const MAX_OPEN_CALLS: usize = 256;
/// When the open map is full, calls untouched for this long are forgotten first
/// (otherwise the oldest goes). A long shell call sends no updates while it
/// runs, so age alone never evicts: its input must survive until `completed`.
pub const OPEN_CALL_TTL: Duration = Duration::from_secs(30 * 60);
/// Recently finished ids remembered so a repeated terminal update is ignored.
const MAX_FINISHED_IDS: usize = 512;

/// One tool call with every fragment seen so far folded in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MergedToolCall {
    pub tool_id: String,
    /// Title/name from the initial `tool_call` (updates carry none).
    pub name: Option<String>,
    pub kind: Option<AcpToolKind>,
    pub status: Option<ToolStatus>,
    pub input: Option<serde_json::Value>,
    pub locations: Vec<ToolLocation>,
    pub diffs: Vec<ToolDiff>,
    pub result_text: Option<String>,
}

impl MergedToolCall {
    /// Fold `ev` in. A non-empty `input`/`locations`/`diffs` is never replaced
    /// by an empty one (claude's `completed` update carries none).
    fn merge(&mut self, ev: &NormalizedEvent) {
        if ev.kind == NormalizedEventKind::ToolUse && ev.tool_name.is_some() {
            self.name = ev.tool_name.clone();
        }
        if ev.tool_kind.is_some() {
            self.kind = ev.tool_kind;
        }
        if ev.tool_status.is_some() {
            self.status = ev.tool_status;
        }
        if let Some(input) = ev.tool_input.as_ref().filter(|v| !is_empty_input(v)) {
            self.input = Some(input.clone());
        }
        if let Some(locs) = ev.tool_locations.as_ref().filter(|l| !l.is_empty()) {
            self.locations = locs.clone();
        }
        if let Some(diffs) = ev.tool_diffs.as_ref().filter(|d| !d.is_empty()) {
            self.diffs = diffs.clone();
        }
        if let Some(text) = ev
            .tool_result
            .as_ref()
            .and_then(|r| r.content.as_ref())
            .filter(|t| !t.is_empty())
        {
            self.result_text = Some(text.clone());
        }
    }
}

fn is_empty_input(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

struct Open {
    call: MergedToolCall,
    touched: Instant,
    seq: u64,
}

/// Bounded per-session tracker keyed by `tool_id` only (in-band and
/// out-of-band events feed the same instance).
#[derive(Default)]
pub struct ToolCallTracker {
    open: HashMap<String, Open>,
    finished: HashSet<String>,
    finished_order: VecDeque<String>,
    next_seq: u64,
}

impl ToolCallTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of calls currently open.
    pub fn open_len(&self) -> usize {
        self.open.len()
    }

    /// Feed one event. Returns the merged call exactly once, when it reaches
    /// `Completed` or `Failed` (check `call.status`: a failed shell call may
    /// still have created files, a failed edit wrote nothing).
    pub fn on_event(&mut self, ev: &NormalizedEvent) -> Option<MergedToolCall> {
        self.on_event_at(ev, Instant::now())
    }

    /// [`Self::on_event`] with an injectable clock (tests).
    pub fn on_event_at(&mut self, ev: &NormalizedEvent, now: Instant) -> Option<MergedToolCall> {
        if !matches!(
            ev.kind,
            NormalizedEventKind::ToolUse | NormalizedEventKind::ToolResult
        ) {
            return None;
        }
        let id = ev.tool_id.clone()?;
        if self.finished.contains(&id) {
            return None;
        }
        if !self.open.contains_key(&id) {
            self.make_room(now);
            self.next_seq += 1;
            self.open.insert(
                id.clone(),
                Open {
                    call: MergedToolCall {
                        tool_id: id.clone(),
                        ..Default::default()
                    },
                    touched: now,
                    seq: self.next_seq,
                },
            );
        }
        let entry = self.open.get_mut(&id)?;
        entry.touched = now;
        entry.call.merge(ev);
        match entry.call.status {
            Some(ToolStatus::Completed | ToolStatus::Failed) => {
                let done = self.open.remove(&id)?.call;
                self.remember_finished(id);
                Some(done)
            }
            _ => None,
        }
    }

    fn evict_stale(&mut self, now: Instant) {
        self.open
            .retain(|_, o| now.saturating_duration_since(o.touched) < OPEN_CALL_TTL);
    }

    /// Drop the oldest open call so one more fits.
    fn make_room(&mut self, now: Instant) {
        if self.open.len() >= MAX_OPEN_CALLS {
            self.evict_stale(now);
        }
        while self.open.len() >= MAX_OPEN_CALLS {
            let Some(oldest) = self
                .open
                .iter()
                .min_by_key(|(_, o)| o.seq)
                .map(|(k, _)| k.clone())
            else {
                return;
            };
            self.open.remove(&oldest);
        }
    }

    fn remember_finished(&mut self, id: String) {
        if self.finished.insert(id.clone()) {
            self.finished_order.push_back(id);
        }
        while self.finished_order.len() > MAX_FINISHED_IDS {
            if let Some(old) = self.finished_order.pop_front() {
                self.finished.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: NormalizedEventKind, id: &str) -> NormalizedEvent {
        let mut e = NormalizedEvent::default();
        e.kind = kind;
        e.tool_id = Some(id.to_string());
        e
    }

    fn loc(p: &str) -> Vec<ToolLocation> {
        vec![ToolLocation {
            path: p.to_string(),
            line: None,
        }]
    }

    #[test]
    fn use_then_completed_yields_one_call_with_merged_fields() {
        let mut t = ToolCallTracker::new();
        let mut a = ev(NormalizedEventKind::ToolUse, "t1");
        a.tool_name = Some("Write".into());
        a.tool_kind = Some(AcpToolKind::Edit);
        a.tool_status = Some(ToolStatus::InProgress);
        a.tool_locations = Some(vec![]);
        assert!(t.on_event(&a).is_none());
        let mut b = ev(NormalizedEventKind::ToolResult, "t1");
        b.tool_locations = Some(loc("/x/a.md"));
        b.tool_input = Some(serde_json::json!({"file_path": "/x/a.md"}));
        assert!(t.on_event(&b).is_none());
        let mut c = ev(NormalizedEventKind::ToolResult, "t1");
        c.tool_status = Some(ToolStatus::Completed);
        c.tool_locations = Some(vec![]);
        c.tool_input = Some(serde_json::json!({}));
        let done = t.on_event(&c).expect("finalized");
        assert_eq!(done.name.as_deref(), Some("Write"));
        assert_eq!(done.kind, Some(AcpToolKind::Edit));
        assert_eq!(done.locations, loc("/x/a.md"));
        assert_eq!(done.input.unwrap()["file_path"], "/x/a.md");
        assert_eq!(t.open_len(), 0);
        // A repeated terminal update does not report twice.
        assert!(t.on_event(&c).is_none());
    }

    #[test]
    fn failed_call_is_reported_once_with_its_status_and_forgotten() {
        let mut t = ToolCallTracker::new();
        let mut a = ev(NormalizedEventKind::ToolUse, "t1");
        a.tool_locations = Some(loc("/x/a.md"));
        t.on_event(&a);
        let mut f = ev(NormalizedEventKind::ToolResult, "t1");
        f.tool_status = Some(ToolStatus::Failed);
        let done = t.on_event(&f).expect("failed calls are reported");
        assert_eq!(done.status, Some(ToolStatus::Failed));
        assert_eq!(done.locations, loc("/x/a.md"));
        assert_eq!(t.open_len(), 0);
        assert!(t.on_event(&f).is_none(), "reported once");
        let mut again = ev(NormalizedEventKind::ToolResult, "t1");
        again.tool_status = Some(ToolStatus::Completed);
        assert!(t.on_event(&again).is_none(), "failed ids stay finished");
    }

    #[test]
    fn first_event_with_everything_finalizes_on_completed_intact() {
        let mut t = ToolCallTracker::new();
        let mut a = ev(NormalizedEventKind::ToolUse, "p1");
        a.tool_kind = Some(AcpToolKind::Edit);
        a.tool_status = Some(ToolStatus::InProgress);
        a.tool_diffs = Some(vec![ToolDiff {
            path: "/x/c.md".into(),
            old_text: None,
            new_text: "c".into(),
            old_start: None,
            new_start: None,
        }]);
        assert!(t.on_event(&a).is_none());
        let mut c = ev(NormalizedEventKind::ToolResult, "p1");
        c.tool_status = Some(ToolStatus::Completed);
        let done = t.on_event(&c).unwrap();
        assert_eq!(done.diffs.len(), 1);
    }

    #[test]
    fn immediate_completed_tool_use_finalizes() {
        let mut t = ToolCallTracker::new();
        let mut a = ev(NormalizedEventKind::ToolUse, "q");
        a.tool_status = Some(ToolStatus::Completed);
        assert!(t.on_event(&a).is_some());
    }

    #[test]
    fn non_tool_events_and_idless_events_are_ignored() {
        let mut t = ToolCallTracker::new();
        assert!(t.on_event(&ev(NormalizedEventKind::Text, "x")).is_none());
        let mut e = NormalizedEvent::default();
        e.kind = NormalizedEventKind::ToolUse;
        assert!(t.on_event(&e).is_none());
        assert_eq!(t.open_len(), 0);
    }

    #[test]
    fn stale_open_calls_are_evicted_only_when_the_map_is_full() {
        let mut t = ToolCallTracker::new();
        let t0 = Instant::now();
        for i in 0..MAX_OPEN_CALLS {
            let mut a = ev(NormalizedEventKind::ToolUse, &format!("old{i}"));
            a.tool_status = Some(ToolStatus::InProgress);
            t.on_event_at(&a, t0);
        }
        assert_eq!(t.open_len(), MAX_OPEN_CALLS);
        let later = t0 + OPEN_CALL_TTL + Duration::from_secs(1);
        t.on_event_at(&ev(NormalizedEventKind::ToolUse, "new"), later);
        assert_eq!(t.open_len(), 1, "stale evicted to make room, new open");
        // The evicted call's completion now starts a fresh (empty) entry, so
        // nothing path-bearing is ever reported for it.
        let mut c = ev(NormalizedEventKind::ToolResult, "old0");
        c.tool_status = Some(ToolStatus::Completed);
        let done = t.on_event_at(&c, later).unwrap();
        assert!(done.locations.is_empty() && done.diffs.is_empty());
    }

    #[test]
    fn a_long_call_keeps_its_input_until_completed() {
        let mut t = ToolCallTracker::new();
        let t0 = Instant::now();
        let mut a = ev(NormalizedEventKind::ToolUse, "long");
        a.tool_status = Some(ToolStatus::InProgress);
        a.tool_input = Some(serde_json::json!({"command": "echo > /w/r.md"}));
        t.on_event_at(&a, t0);
        let mut c = ev(NormalizedEventKind::ToolResult, "long");
        c.tool_status = Some(ToolStatus::Completed);
        let done = t
            .on_event_at(&c, t0 + Duration::from_secs(45 * 60))
            .unwrap();
        assert!(done.input.is_some(), "merged input survives 45 minutes");
    }

    #[test]
    fn open_calls_are_bounded_and_oldest_dropped() {
        let mut t = ToolCallTracker::new();
        for i in 0..300 {
            let mut a = ev(NormalizedEventKind::ToolUse, &format!("c{i}"));
            a.tool_status = Some(ToolStatus::InProgress);
            t.on_event(&a);
        }
        assert_eq!(t.open_len(), MAX_OPEN_CALLS);
        assert!(!t.open.contains_key("c0"));
        assert!(t.open.contains_key("c299"));
    }
}
