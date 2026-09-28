use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};

use crate::daemon_url::{
    get_daemon_token, get_daemon_url, get_daemon_url_from_home_and_env, set_self_heal_override,
};
use crate::launch::{ensure_daemon_reachable, PreflightScope};
use crate::output::die;

/// Classification of a `preflight_with_url` failure — mirrors
/// `commands/open.rs::OpenFailure`'s existing shape. Only `NoDaemon`/`Connect`
/// trigger self-heal (`cli-daemon-unification` Part 03) — a non-2xx response
/// means a daemon IS there and answering, just rejecting for its own reasons,
/// and self-healing in that case would spawn a needless competing daemon.
enum PreflightFailure {
    NoDaemon,
    Connect,
    NotResponding,
}

async fn preflight_with_url_classified(
    url: &str,
    token: Option<&str>,
) -> Result<(), PreflightFailure> {
    let client = reqwest::Client::new();
    let mut headers = HeaderMap::new();
    if let Some(tok) = token {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {tok}")) {
            headers.insert(AUTHORIZATION, val);
        }
    }

    match client
        .get(format!("{url}/health"))
        .headers(headers)
        // Found in review: 3s was too aggressive — a daemon that's merely
        // busy (not actually gone) could miss this window and get treated as
        // dead, triggering a spurious desktop-app launch or a headless spawn
        // that then loses the flock race to the still-alive original (see
        // `launch.rs`'s `we_won` check, which now guards against presenting a
        // pointless login URL in that case too — belt and suspenders, since a
        // merely-slow daemon is still a bad reason to launch anything at all).
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(PreflightFailure::NotResponding)
            }
        }
        // Any transport-level failure (connection refused, or the 8s timeout
        // above tripping on a hung-but-listening daemon) is treated the same
        // way — self-heal, per Key Decision 2: a daemon that never responds
        // within a bounded window is not meaningfully different from "gone"
        // from a self-heal caller's perspective.
        Err(_err) => Err(PreflightFailure::Connect),
    }
}

pub async fn preflight_with_url(url: &str, token: Option<&str>) -> Result<(), String> {
    preflight_with_url_classified(url, token)
        .await
        .map_err(|e| match e {
            PreflightFailure::NoDaemon | PreflightFailure::Connect => {
                "Daemon is not running. Open the vibe-station app to start it.".to_string()
            }
            PreflightFailure::NotResponding => {
                "Daemon is not responding. Restart the vibe-station app.".to_string()
            }
        })
}

/// Zero-arg default — `Normal` scope, self-heals per CUJ1/2a/2b when the
/// daemon is unreachable. The vast majority of commands call this.
pub async fn preflight() {
    preflight_scoped(PreflightScope::Normal).await
}

/// `Exempt` scope skips self-heal entirely and dies immediately on an
/// absent daemon, same as pre-Part-03 behavior — for commands where
/// spawning a fresh daemon just to report on/act against it is meaningless
/// (`vst daemon status`, `vst daemon stop`, `vst status`, `vst agent
/// stop`/`terminate` — R31).
pub async fn preflight_scoped(scope: PreflightScope) {
    let url = get_daemon_url();
    let token = get_daemon_token();

    let failure = match &url {
        Some(u) => preflight_with_url_classified(u, token.as_deref())
            .await
            .err(),
        None => Some(PreflightFailure::NoDaemon),
    };

    let Some(failure) = failure else {
        return; // reachable, nothing to do
    };

    match (scope, failure) {
        (PreflightScope::Exempt, _) | (_, PreflightFailure::NotResponding) => {
            die(
                match url {
                    Some(_) => "Daemon is not responding. Restart the vibe-station app.",
                    None => "Daemon is not running. Open the vibe-station app to start it.",
                },
                Some(4),
            );
        }
        (PreflightScope::Normal, PreflightFailure::NoDaemon | PreflightFailure::Connect) => {
            // Found in review (R44 gap): the failure above may only mean the
            // *env-provided* URL is stale (e.g. an agent's baked-in
            // VST_DAEMON_URL from a daemon that's since been restarted on a
            // new port) — not that no daemon exists at all. Check
            // config.json directly, bypassing the env override, before
            // launching Tauri or spawning a fresh headless daemon: if a
            // daemon is already alive there, just point at it. Skipping this
            // check would otherwise re-launch Tauri (or open a new browser
            // tab) on every single command from a long-lived agent process
            // whose env predates a daemon restart.
            if let Some(config_url) = get_daemon_url_from_home_and_env(None, None) {
                if config_url != url.clone().unwrap_or_default()
                    && preflight_with_url_classified(&config_url, token.as_deref())
                        .await
                        .is_ok()
                {
                    set_self_heal_override(config_url);
                    return;
                }
            }

            if let Err(msg) = ensure_daemon_reachable().await {
                die(&msg, Some(4));
            }
            // ensure_daemon_reachable() sets the self-heal override on
            // success — a fresh get_daemon_url()/get_daemon_token() call now
            // sees the newly-spawned/attached daemon.
            let retry_url = match get_daemon_url() {
                Some(u) => u,
                None => die(
                    "Daemon is not running. Open the vibe-station app to start it.",
                    Some(4),
                ),
            };
            let retry_token = get_daemon_token();
            if let Err(msg) = preflight_with_url(&retry_url, retry_token.as_deref()).await {
                die(&msg, Some(4));
            }
        }
    }
}
