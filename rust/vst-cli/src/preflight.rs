use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};

use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::output::die;

pub async fn preflight_with_url(url: &str, token: Option<&str>) -> Result<(), String> {
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
        .send()
        .await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                Ok(())
            } else {
                Err("Daemon is not responding. Restart the vibe-station app.".to_string())
            }
        }
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("ECONNREFUSED") || msg.contains("connect") || err.is_connect() {
                Err("Daemon is not running. Open the vibe-station app to start it.".to_string())
            } else {
                Err("Failed to reach daemon.".to_string())
            }
        }
    }
}

pub async fn preflight() {
    let url = match get_daemon_url() {
        Some(u) => u,
        None => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(4),
        ),
    };

    let token = get_daemon_token();
    if let Err(msg) = preflight_with_url(&url, token.as_deref()).await {
        die(&msg, Some(4));
    }
}
