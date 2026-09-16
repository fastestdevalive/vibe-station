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

    let full_url = format!("{base_url}{path}");
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
        let text = response.text().await.unwrap_or_default();
        let data: T = match serde_json::from_str(&text) {
            Ok(d) => d,
            Err(_) => serde_json::from_value(Value::Null)?,
        };
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
