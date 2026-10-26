//! The one place the update feature builds `reqwest` clients.

use std::time::Duration;

/// Client for release downloads (GitHub assets, the signed manifest).
pub(crate) fn release_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent(concat!("vibe-station-updater/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
}

/// Client with a whole-request `timeout` (GitHub API check, local `/health`
/// polls by the watcher and the handoff). Falls back to a default client if
/// the builder fails, as every caller already did.
pub(crate) fn timeout_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}
