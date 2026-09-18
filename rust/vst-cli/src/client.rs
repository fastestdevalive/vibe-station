use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::output::die;

#[derive(Debug)]
pub enum DaemonResult<T> {
    Ok {
        status: u16,
        data: T,
    },
    Err {
        status: u16,
        error: String,
        conflict_with: Option<Value>,
    },
}

impl<T> DaemonResult<T> {
    pub fn is_ok(&self) -> bool {
        matches!(self, DaemonResult::Ok { .. })
    }

    pub fn status(&self) -> u16 {
        match self {
            DaemonResult::Ok { status, .. } | DaemonResult::Err { status, .. } => *status,
        }
    }
}

/// The daemon nests all REST routes under `/api` (see
/// `vst-daemon/src/server.rs`'s `.nest("/api", api)`); only `/health`,
/// `/mobile-auth` and `/ws` live at root. Every CLI call path is written
/// root-relative (e.g. `"/sessions"`), so this is the single place that
/// adds the `/api` prefix before the request goes out. Do NOT add `/api`
/// at individual call sites — it belongs here, once, so the routing
/// convention can't drift out of sync again.
fn api_path(path: &str) -> String {
    const ROOT_PATHS: &[&str] = &["/health", "/mobile-auth", "/ws"];
    if path.starts_with("/api/") || ROOT_PATHS.iter().any(|p| path == *p || path.starts_with(&format!("{p}?"))) {
        path.to_string()
    } else if let Some(rest) = path.strip_prefix('/') {
        format!("/api/{rest}")
    } else {
        format!("/api/{path}")
    }
}

pub async fn daemon_request_with_base<T: DeserializeOwned, B: Serialize>(
    base_url: &str,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<&B>,
) -> anyhow::Result<DaemonResult<T>> {
    let client = reqwest::Client::new();
    let mut headers = HeaderMap::new();

    if body.is_some() {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }

    if let Some(tok) = token {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {tok}")) {
            headers.insert(AUTHORIZATION, val);
        }
    }

    let full_url = format!("{base_url}{}", api_path(path));
    let mut req = client.request(method, &full_url).headers(headers);

    if let Some(b) = body {
        req = req.json(b);
    }

    let response = match req.send().await {
        Ok(resp) => resp,
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("ECONNREFUSED") || msg.contains("connect") || err.is_connect() {
                die(
                    "Daemon is not running. Open the vibe-station app to start it.",
                    Some(4),
                );
            }
            return Err(err.into());
        }
    };

    let status = response.status().as_u16();

    if (200..300).contains(&status) {
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response.text().await.unwrap_or_default();
        // A 2xx with an empty body (e.g. 204 No Content) has no JSON to parse
        // at all — treat it the same as an explicit `null`, same as before.
        let parse_target: &str = if text.trim().is_empty() { "null" } else { &text };
        let data: T = serde_json::from_str(parse_target).map_err(|err| {
            let snippet: String = text.chars().take(200).collect();
            anyhow::anyhow!(
                "daemon response for {full_url} was not valid JSON for the expected shape \
                 (status {status}, content-type {content_type:?}): {err}\nbody: {snippet}"
            )
        })?;
        Ok(DaemonResult::Ok { status, data })
    } else {
        let text = response.text().await.unwrap_or_default();
        let val: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

        let error = val
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error")
            .to_string();

        let conflict_with = val.get("conflictWith").cloned();

        Ok(DaemonResult::Err {
            status,
            error,
            conflict_with,
        })
    }
}

pub async fn daemon_request<T: DeserializeOwned, B: Serialize>(
    method: Method,
    path: &str,
    body: Option<&B>,
) -> anyhow::Result<DaemonResult<T>> {
    let url = match get_daemon_url() {
        Some(u) => u,
        None => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(4),
        ),
    };
    let token = get_daemon_token();
    daemon_request_with_base(&url, token.as_deref(), method, path, body).await
}

pub async fn daemon_get<T: DeserializeOwned>(path: &str) -> anyhow::Result<DaemonResult<T>> {
    daemon_request::<T, ()>(Method::GET, path, None).await
}

pub async fn daemon_post<T: DeserializeOwned, B: Serialize>(
    path: &str,
    body: Option<&B>,
) -> anyhow::Result<DaemonResult<T>> {
    daemon_request::<T, B>(Method::POST, path, body).await
}

pub async fn daemon_put<T: DeserializeOwned, B: Serialize>(
    path: &str,
    body: Option<&B>,
) -> anyhow::Result<DaemonResult<T>> {
    daemon_request::<T, B>(Method::PUT, path, body).await
}

pub async fn daemon_patch<T: DeserializeOwned, B: Serialize>(
    path: &str,
    body: Option<&B>,
) -> anyhow::Result<DaemonResult<T>> {
    daemon_request::<T, B>(Method::PATCH, path, body).await
}

pub async fn daemon_delete<T: DeserializeOwned>(path: &str) -> anyhow::Result<DaemonResult<T>> {
    daemon_request::<T, ()>(Method::DELETE, path, None).await
}

#[cfg(test)]
mod tests {
    use super::api_path;

    #[test]
    fn prefixes_rest_paths_with_api() {
        assert_eq!(api_path("/sessions"), "/api/sessions");
        assert_eq!(api_path("/worktrees?project=p1"), "/api/worktrees?project=p1");
        assert_eq!(api_path("/sessions/abc/rename"), "/api/sessions/abc/rename");
        assert_eq!(api_path("/open"), "/api/open");
    }

    #[test]
    fn leaves_root_level_paths_alone() {
        assert_eq!(api_path("/health"), "/health");
        assert_eq!(api_path("/mobile-auth"), "/mobile-auth");
        assert_eq!(api_path("/ws"), "/ws");
    }

    #[test]
    fn is_idempotent_on_already_prefixed_paths() {
        assert_eq!(api_path("/api/sessions"), "/api/sessions");
    }
}
