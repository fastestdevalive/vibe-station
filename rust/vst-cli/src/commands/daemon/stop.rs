//! `vst daemon stop`
//!
//! Sends `POST /api/daemon/stop` (authenticated, same as any other `/api`
//! route), then polls `/health` until the connection is refused (daemon
//! actually gone) or a timeout elapses. The polling matters for `vst update`
//! (a later part of `cli-daemon-unification`), which runs `stop` immediately
//! followed by a fresh `vst daemon run` — without waiting for the old
//! process to actually release its flock, the new one's `acquire_lock` could
//! race the still-shutting-down old one and bail spuriously.

use std::time::Duration;

use crate::client::{daemon_post, DaemonResult};
use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::launch::PreflightScope;
use crate::output::{die, success};
use crate::preflight::{preflight_scoped, preflight_with_url};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const POLL_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn run_daemon_stop() -> Result<(), (String, i32)> {
    // Exempt (R31): spawning a fresh daemon just to immediately stop it
    // again would be pointless — if there's no daemon, there's nothing to
    // stop, and today's die-on-absent message is the correct outcome.
    preflight_scoped(PreflightScope::Exempt).await;

    // Resolved once, before the POST — `get_daemon_url`/`get_daemon_token`
    // read config.json, which stays on disk after the daemon exits (only its
    // *port* being unreachable signals "gone"), so it's safe to reuse these
    // for the polling loop below too.
    let url = get_daemon_url().unwrap_or_default();
    let token = get_daemon_token();

    let result = daemon_post::<serde_json::Value, ()>("/daemon/stop", None)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {}
        DaemonResult::Err { .. } => {
            die("Failed to request daemon stop", Some(4));
        }
    }

    // NOTE: deliberately does NOT reuse `daemon_get`/`daemon_post` here —
    // both go through `client.rs::daemon_request_with_base`, which calls
    // `die()` (a hard `process::exit`) directly on connection-refused rather
    // than returning an `Err` this loop could catch. `preflight_with_url`
    // returns a real `Result`, which is what a "poll until gone" loop needs.
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > POLL_TIMEOUT {
            die(
                "Stop requested, but the daemon did not exit within 10s",
                Some(4),
            );
        }
        match preflight_with_url(&url, token.as_deref()).await {
            Err(_) => break, // connection refused (or any other failure) — daemon is gone
            Ok(()) => tokio::time::sleep(POLL_INTERVAL).await,
        }
    }

    success("Daemon stopped");
    Ok(())
}
