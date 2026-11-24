//! Idle reaper: ends an agent child process nothing has used for 2 hours
//! (checked every 10 minutes, so a child lives up to ~2 h 10 min idle).
//!
//! The session object stays registered (it holds no fds once its store is
//! closed); the next send respawns the child through `get_or_create_connection`,
//! which `session/load`s the stored id, exactly like a daemon-restart resume.
//! "Dormant" is therefore derived (`connection.is_none()`), never stored, and
//! reaping writes no lifecycle (the lifecycle writers keep their single owner).

use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use super::JsonAgentSession;
use crate::acp_connection::AcpConnection;
use crate::acp_transport::AcpTransport;
use crate::json_agent_registry::JsonAgentRegistry;

pub const AGENT_IDLE_REAP_AFTER: Duration = Duration::from_secs(2 * 60 * 60);
const REAP_SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Env override in seconds; `0` turns the reaper off.
const REAP_ENV: &str = "VST_AGENT_IDLE_REAP_SECS";

impl JsonAgentSession {
    /// Dispose this session's agent child if it has been idle for `after`.
    /// Returns whether a child was reaped.
    ///
    /// Idle means: no running or queued turn, no held review turn, no open
    /// out-of-band window, no tracked background task (a task whose hold lapsed
    /// still counts: disposing SIGKILLs the agent's process group and with it the
    /// task), no pending scheduled message, no attached chat listener, and the
    /// agent can resume its session (`loadSession`); otherwise reaping would
    /// start a fresh conversation.
    pub async fn reap_agent_if_idle(&self, after: Duration) -> bool {
        if self.is_released() {
            return false;
        }
        // Read outside `state` (lock order). A change in between is harmless: new
        // work or agent activity bumps `last_busy_at`, rechecked under the lock
        // below, and a listener attaching late needs no child (opening never spawns).
        let hold = self.0.tasks.hold();
        if hold.holding > 0 || hold.grace_active || !hold.lapsed.is_empty() {
            return false;
        }
        if self.0.stream.message_listener_count() > 0 {
            return false;
        }
        let pending = self
            .0
            .store_handle
            .count_pending_schedule_rows(&self.0.session_id)
            .await;
        if !matches!(pending, Ok(0)) {
            return false;
        }
        // The check and the take share one lock, so a send racing the reap either
        // lands first (queue/`last_busy_at`) or finds no connection and respawns.
        let conn = {
            let mut s = self.0.state.lock().unwrap();
            let idle = s
                .connection
                .as_ref()
                .is_some_and(AcpConnection::supports_load_session)
                && !s.running
                && s.queue.is_empty()
                && s.holds.is_empty()
                && !s.bg_working
                && s.last_busy_at.elapsed() >= after;
            if !idle {
                return false;
            }
            s.connection.take()
        };
        let Some(conn) = conn else { return false };
        // Fire-and-forget: the pipes close shortly after this returns.
        conn.dispose().await;
        tracing::info!(session_id = %self.0.session_id, "[json-agent] reaped idle agent");
        true
    }
}

/// The idle threshold from `VST_AGENT_IDLE_REAP_SECS`: unset or invalid is 2 h,
/// `0` disables the reaper.
pub fn reap_after_from_env() -> Option<Duration> {
    parse_reap_after(std::env::var(REAP_ENV).ok().as_deref())
}

fn parse_reap_after(raw: Option<&str>) -> Option<Duration> {
    match raw.and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(0) => None,
        Some(secs) => Some(Duration::from_secs(secs)),
        None => Some(AGENT_IDLE_REAP_AFTER),
    }
}

/// One task sweeping every registered session; sessions are reaped in turn.
pub fn spawn_idle_reaper(
    registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    after: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(REAP_SWEEP_INTERVAL);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            for session in registry.all() {
                session.reap_agent_if_idle(after).await;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_parse_table() {
        assert_eq!(parse_reap_after(None), Some(AGENT_IDLE_REAP_AFTER));
        assert_eq!(parse_reap_after(Some("0")), None);
        assert_eq!(parse_reap_after(Some("60")), Some(Duration::from_secs(60)));
        assert_eq!(parse_reap_after(Some("x")), Some(AGENT_IDLE_REAP_AFTER));
        assert_eq!(parse_reap_after(Some("")), Some(AGENT_IDLE_REAP_AFTER));
    }
}
