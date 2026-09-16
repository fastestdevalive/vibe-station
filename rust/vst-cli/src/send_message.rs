use std::fs;
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::multipart::{Form, Part};
use vst_types::domain::{Attachment, Channel, LifecycleState};
use vst_types::rest::attachments::AttachmentsResult;
use vst_types::rest::sessions::{InputBody, SessionOrDraft, SessionOutput};

use crate::client::{daemon_get, daemon_post, DaemonResult};
use crate::daemon_url::{get_daemon_token, get_daemon_url_or_throw};
use crate::output::{die, warn};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SendOptions {
    pub file: Option<String>,
    pub attach: Vec<String>,
    pub queue: bool,
    pub wait: bool,
    pub timeout: Option<String>,
}

fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

async fn upload_file(session_id: &str, file_path: &str) -> Attachment {
    let url = get_daemon_url_or_throw();
    let token = get_daemon_token();
    let path = Path::new(file_path);

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(err) => die(&format!("Failed to read file {file_path}: {err}"), Some(1)),
    };

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let part = Part::bytes(bytes).file_name(filename);
    let form = Form::new().part("files", part);

    let mut headers = HeaderMap::new();
    if let Some(tok) = token {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {tok}")) {
            headers.insert(AUTHORIZATION, val);
        }
    }

    let client = reqwest::Client::new();
    let encoded_id = encode_component(session_id);
    let upload_url = format!("{url}/sessions/{encoded_id}/attachments");

    let resp = match client
        .post(&upload_url)
        .headers(headers)
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => die(&format!("Upload failed: {err}"), Some(1)),
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let err_json: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        let msg = err_json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(&format!("Upload failed (HTTP {status})"))
            .to_string();
        die(&msg, Some(1));
    }

    let text = resp.text().await.unwrap_or_default();
    let res: AttachmentsResult = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(err) => die(&format!("Upload response parse error: {err}"), Some(1)),
    };

    match res.attachments.into_iter().next() {
        Some(att) => att,
        None => die("Upload returned no attachment", Some(1)),
    }
}

async fn print_reply(session_id: &str) {
    let encoded_id = encode_component(session_id);
    if let Ok(DaemonResult::Ok { data, .. }) =
        daemon_get::<SessionOutput>(&format!("/sessions/{encoded_id}/output?lines=50")).await
    {
        println!("{}", data.output);
    }
}

pub async fn run_send(
    session_id: &str,
    message_parts: &[String],
    opts: &SendOptions,
) -> anyhow::Result<()> {
    let mut content = message_parts.join(" ");
    if let Some(file_path) = &opts.file {
        content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(err) => die(&format!("Failed to read file {file_path}: {err}"), Some(1)),
        };
    }

    if content.trim().is_empty() {
        die("Provide a message or --file", Some(1));
    }

    let mut attachment_ids = Vec::new();
    if !opts.attach.is_empty() {
        let encoded_id = encode_component(session_id);
        let info_result = daemon_get::<SessionOrDraft>(&format!("/sessions/{encoded_id}")).await?;
        match info_result {
            DaemonResult::Ok { data, .. } => {
                let channel = match &data {
                    SessionOrDraft::Session(s) => s.channel,
                    SessionOrDraft::GlobalDraft(g) => g.channel,
                };
                if channel != Channel::Json {
                    die(
                        "Attachments require a Rich Chat (json) session — --attach is not supported on tmux/pty targets",
                        Some(1),
                    );
                }
            }
            DaemonResult::Err { status, error, .. } => {
                die(&error, Some(if status == 404 { 2 } else { 1 }));
            }
        }

        for f in &opts.attach {
            let att = upload_file(session_id, f).await;
            attachment_ids.push(att.id);
        }
    }

    let input_body = InputBody {
        data: content,
        send_enter: Some(true),
        attachment_ids: if attachment_ids.is_empty() {
            None
        } else {
            Some(attachment_ids)
        },
        queue: if opts.queue { Some(true) } else { None },
    };

    let encoded_id = encode_component(session_id);
    let send_result = daemon_post::<serde_json::Value, _>(
        &format!("/sessions/{encoded_id}/send"),
        Some(&input_body),
    )
    .await?;

    match send_result {
        DaemonResult::Ok { .. } => {}
        DaemonResult::Err { status, error, .. } => {
            die(&error, Some(if status == 404 { 2 } else { 1 }));
        }
    }

    if opts.wait {
        let timeout_ms: u64 = opts
            .timeout
            .as_deref()
            .and_then(|t| t.parse().ok())
            .unwrap_or(60000);
        let poll_interval = Duration::from_millis(500);

        sleep(poll_interval).await;
        let start_time = std::time::Instant::now();

        while start_time.elapsed().as_millis() < timeout_ms as u128 {
            let status_result =
                daemon_get::<SessionOrDraft>(&format!("/sessions/{encoded_id}")).await?;
            let state = match status_result {
                DaemonResult::Ok { data, .. } => match data {
                    SessionOrDraft::Session(s) => s.state,
                    SessionOrDraft::GlobalDraft(g) => g.state,
                },
                DaemonResult::Err { status, error, .. } => {
                    die(&error, Some(if status == 404 { 2 } else { 1 }));
                }
            };

            if state == LifecycleState::Idle || state == LifecycleState::WaitingForHuman {
                if !opts.queue {
                    print_reply(session_id).await;
                }
                return Ok(());
            }

            sleep(poll_interval).await;
        }

        warn("Session did not settle (idle / waiting_for_human) within timeout");
    }

    Ok(())
}
