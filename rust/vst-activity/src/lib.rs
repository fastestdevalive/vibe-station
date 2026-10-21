//! `vst-activity` — the single owner of per-session `lastActivityAt` / `lastTool`
//! (the `lastLine` column is reserved and no longer written).
//!
//! Producers (`vst-agents` Rich Chat, `vst-lifecycle` terminal poller) call
//! [`ActivitySink::record`] on every sign of life; this crate coalesces those
//! calls with a leading + trailing throttle (at most one persisted write and one
//! `session:activity` broadcast per session per [`THROTTLE`]) and is the only
//! writer of the two columns. No poll loop: a trailing flush is one
//! `tokio::time::sleep` armed by the first record inside the window.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::time::Instant;
use vst_store::StoreHandle;
use vst_types::activity::{ActivitySink, ToolActivity};
use vst_types::{Broadcaster, ServerEvent};

/// Minimum spacing between flushes for one session.
pub const THROTTLE: Duration = Duration::from_secs(5);

/// Entries with no record for this long (and nothing pending) are evicted so
/// the map cannot grow with every session ever seen.
pub const IDLE_EVICT: Duration = Duration::from_secs(10 * 60);

struct Entry {
    project_id: String,
    /// ISO time of the most recent `record`.
    at: String,
    /// When the most recent `record` arrived (for idle eviction).
    last_seen: Instant,
    /// Most recent tool call.
    tool: Option<ToolActivity>,
    /// `tool` changed since the last snapshot (only then is it persisted and
    /// broadcast; an identical repeat is a no-op for this field).
    tool_pending: bool,
    /// A record arrived since the last snapshot.
    dirty: bool,
    last_flush: Option<Instant>,
    timer_armed: bool,
}

struct Inner {
    store: StoreHandle,
    broadcaster: Broadcaster,
    entries: Mutex<HashMap<String, Entry>>,
}

/// Throttled writer + broadcaster of session activity.
#[derive(Clone)]
pub struct ActivityTracker {
    inner: Arc<Inner>,
}

impl ActivityTracker {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                store,
                broadcaster,
                entries: Mutex::new(HashMap::new()),
            }),
        })
    }

    /// Persist + broadcast one snapshot in the background.
    fn spawn_write(&self, session_id: String, snap: Snapshot) {
        let inner = self.inner.clone();
        tokio::spawn(async move { write_snapshot(&inner, session_id, snap).await });
    }

    /// Arm the single trailing flush: sleep `due`, then flush whatever the
    /// entry holds by then (if anything changed).
    fn spawn_trailing(&self, session_id: String, due: Duration) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(due).await;
            let snap = {
                let mut map = inner.entries.lock().unwrap();
                let Some(e) = map.get_mut(&session_id) else {
                    return;
                };
                e.timer_armed = false;
                e.last_flush = Some(Instant::now());
                let snap = e.take_snapshot();
                evict_idle(&mut map, Instant::now());
                snap
            };
            if let Some(snap) = snap {
                write_snapshot(&inner, session_id, snap).await;
            }
        });
    }
}

/// `(project_id, at, tool)`; `tool` is `Some` only when it changed.
type Snapshot = (String, String, Option<ToolActivity>);

/// Drop entries idle past [`IDLE_EVICT`] with nothing pending.
fn evict_idle(map: &mut HashMap<String, Entry>, now: Instant) {
    map.retain(|_, e| e.timer_armed || e.dirty || now.duration_since(e.last_seen) <= IDLE_EVICT);
}

impl Entry {
    /// A snapshot if something changed since the last one.
    fn take_snapshot(&mut self) -> Option<Snapshot> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let tool = if std::mem::take(&mut self.tool_pending) {
            self.tool.clone()
        } else {
            None
        };
        Some((self.project_id.clone(), self.at.clone(), tool))
    }
}

async fn write_snapshot(inner: &Inner, session_id: String, snap: Snapshot) {
    let (project_id, at, tool) = snap;
    match inner
        .store
        .update_session_activity(&project_id, &session_id, &at, tool.as_ref())
        .await
    {
        Ok(true) => inner.broadcaster.send(ServerEvent::SessionActivity {
            session_id,
            last_activity_at: at,
            last_line: None,
            last_tool: tool,
        }),
        Ok(false) => {
            inner.entries.lock().unwrap().remove(&session_id);
        }
        Err(e) => tracing::warn!(session = %session_id, error = %e, "activity write failed"),
    }
}

impl ActivitySink for ActivityTracker {
    fn record(&self, project_id: &str, session_id: &str) {
        self.record_inner(project_id, session_id, None);
    }

    fn record_tool(&self, project_id: &str, session_id: &str, tool: ToolActivity) {
        self.record_inner(project_id, session_id, Some(tool));
    }

    fn forget(&self, session_id: &str) {
        self.inner.entries.lock().unwrap().remove(session_id);
    }
}

impl ActivityTracker {
    fn record_inner(&self, project_id: &str, session_id: &str, tool: Option<ToolActivity>) {
        let now = Instant::now();
        let mut map = self.inner.entries.lock().unwrap();
        let e = map.entry(session_id.to_string()).or_insert_with(|| Entry {
            project_id: project_id.to_string(),
            at: String::new(),
            last_seen: now,
            tool: None,
            tool_pending: false,
            dirty: false,
            last_flush: None,
            timer_armed: false,
        });
        e.at = now_iso();
        e.dirty = true;
        e.last_seen = now;
        if let Some(t) = tool {
            if e.tool.as_ref() != Some(&t) {
                e.tool = Some(t);
                e.tool_pending = true;
            }
        }
        if e.timer_armed {
            return; // a trailing flush is already pending and will pick this up
        }
        let due = e
            .last_flush
            .map_or(Duration::ZERO, |t| THROTTLE.saturating_sub(now - t));
        if due.is_zero() {
            // Leading edge: flush now (snapshot taken here, under the lock).
            // Does not touch `timer_armed`.
            e.last_flush = Some(now);
            let snap = e.take_snapshot();
            evict_idle(&mut map, now);
            drop(map);
            if let Some(snap) = snap {
                self.spawn_write(session_id.to_string(), snap);
            }
        } else {
            e.timer_armed = true;
            drop(map);
            self.spawn_trailing(session_id.to_string(), due);
        }
    }
}

fn now_iso() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let (sec, min, hour) = (secs % 60, (secs / 60) % 60, (secs / 3600) % 24);
    let (y, mo, day) = civil_from_days((secs / 86400) as i64);
    format!(
        "{y:04}-{mo:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{:03}Z",
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 -> (year, month, day) (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests;
