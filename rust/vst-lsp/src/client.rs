use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, error, warn};

#[derive(Debug, thiserror::Error)]
pub enum LspClientError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Request timed out (10s)")]
    Timeout,
    #[error("RPC channel closed")]
    ChannelClosed,
    #[error("LSP server error: code={code}, message={message}")]
    RpcError { code: i64, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressKind {
    Begin,
    Report,
    End,
}

#[derive(Debug, Clone)]
pub struct ProgressNotification {
    pub token: Value,
    pub kind: ProgressKind,
    pub title: Option<String>,
    pub message: Option<String>,
    pub percentage: Option<u32>,
}

/// `health` of rust-analyzer's `experimental/serverStatus` notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerHealth {
    Ok,
    Warning,
    Error,
}

/// rust-analyzer's `experimental/serverStatus` (opted into via the
/// `experimental.serverStatusNotification` client capability). `quiescent`
/// is the server's own "no background work pending" signal — far more
/// reliable than inferring readiness from `$/progress` tokens, which leave
/// gaps between phases. `health` reports problems such as `cargo metadata`
/// failing, where the server is up but can't resolve dependencies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerStatusNotification {
    pub health: ServerHealth,
    pub quiescent: bool,
    pub message: Option<String>,
}

/// A `window/logMessage` / `window/showMessage` notification. `level` is the
/// LSP `MessageType` (1 error, 2 warning, 3 info, 4 log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerLogMessage {
    pub level: u8,
    pub text: String,
}

/// Every notification stream a client produces. All close when the reader
/// task ends (server EOF / I/O error).
pub struct LspClientChannels {
    pub progress: mpsc::UnboundedReceiver<ProgressNotification>,
    pub server_status: mpsc::UnboundedReceiver<ServerStatusNotification>,
    pub log: mpsc::UnboundedReceiver<ServerLogMessage>,
}

pub struct LspClient {
    next_id: AtomicU64,
    outgoing_tx: mpsc::UnboundedSender<String>,
    pending_requests: PendingMap,
    /// Set by the reader task once the server's stdout is gone.
    closed: Arc<AtomicBool>,
}

/// In-flight requests: id → the reply channel for that request.
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, LspClientError>>>>>;

impl LspClient {
    pub fn new<R, W>(
        reader: R,
        writer: W,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<ProgressNotification>)
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (client, progress_rx, _status_rx) = Self::new_with_server_status(reader, writer);
        (client, progress_rx)
    }

    /// Like [`LspClient::new`], additionally returning a receiver for
    /// `experimental/serverStatus` notifications. Both receivers close when
    /// the reader task ends (server EOF / I/O error).
    #[allow(clippy::type_complexity)]
    pub fn new_with_server_status<R, W>(
        reader: R,
        writer: W,
    ) -> (
        Arc<Self>,
        mpsc::UnboundedReceiver<ProgressNotification>,
        mpsc::UnboundedReceiver<ServerStatusNotification>,
    )
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (client, channels) = Self::new_with_channels(reader, writer);
        (client, channels.progress, channels.server_status)
    }

    /// Like [`LspClient::new_with_server_status`], additionally exposing the
    /// server's `window/logMessage` / `window/showMessage` notifications.
    pub fn new_with_channels<R, W>(reader: R, mut writer: W) -> (Arc<Self>, LspClientChannels)
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<String>();
        let (progress_tx, progress_rx) = mpsc::unbounded_channel::<ProgressNotification>();
        let (status_tx, status_rx) = mpsc::unbounded_channel::<ServerStatusNotification>();
        let (log_tx, log_rx) = mpsc::unbounded_channel::<ServerLogMessage>();
        let pending_requests: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        let client = Arc::new(Self {
            next_id: AtomicU64::new(1),
            outgoing_tx: outgoing_tx.clone(),
            pending_requests: pending_requests.clone(),
            closed: closed.clone(),
        });

        // Writer task: frame messages with Content-Length and write out
        tokio::spawn(async move {
            while let Some(msg) = outgoing_rx.recv().await {
                let frame = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
                if let Err(e) = writer.write_all(frame.as_bytes()).await {
                    error!("LSP client writer error: {e}");
                    break;
                }
                if let Err(e) = writer.flush().await {
                    error!("LSP client flush error: {e}");
                    break;
                }
            }
        });

        // Reader task: parse Content-Length framed JSON-RPC messages
        let outgoing_for_reader = outgoing_tx.clone();
        let pending_for_reader = pending_requests.clone();
        tokio::spawn(async move {
            Self::read_loop(
                reader,
                &outgoing_for_reader,
                &pending_for_reader,
                &progress_tx,
                &status_tx,
                &log_tx,
            )
            .await;
            closed.store(true, Ordering::SeqCst);
            // The server is gone: fail every in-flight request now, so e.g. an
            // `initialize` the server exited before answering reports
            // `ChannelClosed` instead of waiting out the 10 s timeout.
            let drained: Vec<_> = pending_for_reader
                .lock()
                .await
                .drain()
                .map(|(_, tx)| tx)
                .collect();
            for tx in drained {
                let _ = tx.send(Err(LspClientError::ChannelClosed));
            }
        });

        (
            client,
            LspClientChannels {
                progress: progress_rx,
                server_status: status_rx,
                log: log_rx,
            },
        )
    }

    async fn read_loop<R: AsyncRead + Unpin>(
        reader: R,
        outgoing_for_reader: &mpsc::UnboundedSender<String>,
        pending_for_reader: &PendingMap,
        progress_tx: &mpsc::UnboundedSender<ProgressNotification>,
        status_tx: &mpsc::UnboundedSender<ServerStatusNotification>,
        log_tx: &mpsc::UnboundedSender<ServerLogMessage>,
    ) {
        let mut buf_reader = BufReader::new(reader);
        loop {
            // Read headers until \r\n\r\n or empty line
            let mut content_length: Option<usize> = None;
            loop {
                let mut line = String::new();
                match buf_reader.read_line(&mut line).await {
                    Ok(0) => return, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            break; // Header separator reached
                        }
                        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                            if let Ok(len) = rest.trim().parse::<usize>() {
                                content_length = Some(len);
                            }
                        }
                    }
                    Err(e) => {
                        error!("LSP client header read error: {e}");
                        return;
                    }
                }
            }

            let Some(len) = content_length else {
                continue;
            };

            let mut body = vec![0u8; len];
            if let Err(e) = buf_reader.read_exact(&mut body).await {
                error!("LSP client body read error: {e}");
                return;
            }

            let value: Value = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(e) => {
                    error!("LSP client JSON parse error: {e}");
                    continue;
                }
            };

            debug!("LSP client received: {value}");

            // Dispatch message
            if let Some(id_val) = value.get("id") {
                if let Some(method_val) = value.get("method") {
                    // Server-to-client request (has method AND id)
                    let id = id_val.clone();
                    let method = method_val.as_str().unwrap_or_default();
                    Self::handle_server_request(method, id, &value, outgoing_for_reader);
                } else {
                    // Server response to client request
                    let req_id = id_val.as_u64();
                    if let Some(id) = req_id {
                        let sender = pending_for_reader.lock().await.remove(&id);
                        if let Some(tx) = sender {
                            if let Some(err) = value.get("error") {
                                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                                let message = err
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown RPC error")
                                    .to_string();
                                let _ = tx.send(Err(LspClientError::RpcError { code, message }));
                            } else {
                                let result = value.get("result").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(Ok(result));
                            }
                        }
                    }
                }
            } else if let Some(method_val) = value.get("method") {
                // Server-to-client notification (no id)
                let method = method_val.as_str().unwrap_or_default();
                let params = value.get("params");
                match method {
                    "$/progress" => {
                        if let Some(progress) = params.and_then(Self::parse_progress_notification) {
                            let _ = progress_tx.send(progress);
                        }
                    }
                    "experimental/serverStatus" => {
                        if let Some(status) = params.and_then(parse_server_status) {
                            let _ = status_tx.send(status);
                        }
                    }
                    "window/logMessage" | "window/showMessage" => {
                        if let Some(msg) = params.and_then(parse_log_message) {
                            let _ = log_tx.send(msg);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn handle_server_request(
        method: &str,
        id: Value,
        value: &Value,
        outgoing: &mpsc::UnboundedSender<String>,
    ) {
        match method {
            "window/workDoneProgress/create" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null
                });
                let _ = outgoing.send(resp.to_string());
            }
            "client/registerCapability" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null
                });
                let _ = outgoing.send(resp.to_string());
            }
            "workspace/configuration" => {
                let items_count = value
                    .get("params")
                    .and_then(|p| p.get("items"))
                    .and_then(|items| items.as_array())
                    .map(|arr| arr.len())
                    .unwrap_or(0);
                let result = vec![json!({}); items_count];
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result
                });
                let _ = outgoing.send(resp.to_string());
            }
            _ => {
                warn!("Unhandled server-to-client request: {method}");
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null
                });
                let _ = outgoing.send(resp.to_string());
            }
        }
    }

    fn parse_progress_notification(params: &Value) -> Option<ProgressNotification> {
        let token = params.get("token")?.clone();
        let value = params.get("value")?;
        let kind_str = value.get("kind")?.as_str()?;
        let kind = match kind_str {
            "begin" => ProgressKind::Begin,
            "report" => ProgressKind::Report,
            "end" => ProgressKind::End,
            _ => return None,
        };
        let title = value
            .get("title")
            .and_then(|t| t.as_str())
            .map(String::from);
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .map(String::from);
        let percentage = value
            .get("percentage")
            .and_then(|p| p.as_u64())
            .map(|p| p as u32);

        Some(ProgressNotification {
            token,
            kind,
            title,
            message,
            percentage,
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, LspClientError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending_requests.lock().await;
            map.insert(id, tx);
        }
        // The reader may have exited (and drained) before we registered.
        if self.closed.load(Ordering::SeqCst) {
            self.pending_requests.lock().await.remove(&id);
            return Err(LspClientError::ChannelClosed);
        }

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        self.outgoing_tx
            .send(msg.to_string())
            .map_err(|_| LspClientError::ChannelClosed)?;

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(LspClientError::ChannelClosed),
            Err(_) => {
                let mut map = self.pending_requests.lock().await;
                map.remove(&id);
                Err(LspClientError::Timeout)
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), LspClientError> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        self.outgoing_tx
            .send(msg.to_string())
            .map_err(|_| LspClientError::ChannelClosed)
    }

    /// Fail every outstanding pending request, e.g. when the child process dies
    /// / the reader task hits EOF — so requests don't hang waiting on a response
    /// that will never come from a dead server.
    pub async fn fail_pending(&self) {
        let mut map = self.pending_requests.lock().await;
        let drained: Vec<_> = map.drain().map(|(_, tx)| tx).collect();
        for tx in drained {
            let _ = tx.send(Err(LspClientError::ChannelClosed));
        }
    }

    pub async fn initialize(
        &self,
        root_path: &Path,
        init_options: Option<Value>,
    ) -> Result<Value, LspClientError> {
        let root_canon = root_path
            .canonicalize()
            .unwrap_or_else(|_| root_path.to_path_buf());
        let root_uri = crate::uri::path_to_uri(&root_canon);
        let root_path_str = root_canon.to_string_lossy().into_owned();

        let mut init_params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "rootPath": root_path_str,
            "capabilities": {
                "workspace": {
                    "configuration": true,
                    "didChangeWatchedFiles": { "dynamicRegistration": true }
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": true,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "didSave": false
                    },
                    "definition": { "dynamicRegistration": true, "linkSupport": true },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "references": { "dynamicRegistration": true },
                    "documentSymbol": {
                        "hierarchicalDocumentSymbolSupport": true
                    }
                },
                "window": {
                    "workDoneProgress": true
                },
                // rust-analyzer: send `experimental/serverStatus` (quiescent +
                // health). Servers that don't know it ignore the key.
                "experimental": {
                    "serverStatusNotification": true
                }
            }
        });

        if let Some(opts) = init_options {
            init_params["initializationOptions"] = opts;
        }

        let resp = self.request("initialize", init_params).await?;
        self.notify("initialized", json!({}))?;
        Ok(resp)
    }
}

/// Parses `experimental/serverStatus` params. `quiescent` is required; an
/// unknown `health` is treated as `Ok` rather than dropping the notification.
pub fn parse_server_status(params: &Value) -> Option<ServerStatusNotification> {
    let quiescent = params.get("quiescent")?.as_bool()?;
    let health = match params.get("health").and_then(|h| h.as_str()) {
        Some("warning") => ServerHealth::Warning,
        Some("error") => ServerHealth::Error,
        _ => ServerHealth::Ok,
    };
    let message = params
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(String::from);
    Some(ServerStatusNotification {
        health,
        quiescent,
        message,
    })
}

/// Parses `window/logMessage` / `window/showMessage` params.
pub fn parse_log_message(params: &Value) -> Option<ServerLogMessage> {
    let text = params.get("message")?.as_str()?.to_string();
    let level = params
        .get("type")
        .and_then(|t| t.as_u64())
        .map(|t| t.min(u8::MAX as u64) as u8)
        .unwrap_or(4);
    Some(ServerLogMessage { level, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_message() {
        let m =
            parse_log_message(&json!({ "type": 3, "message": "Using Typescript 5.9.3" })).unwrap();
        assert_eq!(m.level, 3);
        assert_eq!(m.text, "Using Typescript 5.9.3");
        assert_eq!(
            parse_log_message(&json!({ "message": "x" })).unwrap().level,
            4
        );
        assert!(parse_log_message(&json!({ "type": 1 })).is_none());
    }

    #[tokio::test]
    async fn pending_request_fails_fast_when_server_exits() {
        let (client_read, server_write) = tokio::io::duplex(1024);
        let (_server_read, client_write) = tokio::io::duplex(1024);
        let (client, _rx) = LspClient::new(client_read, client_write);
        let req = tokio::spawn(async move { client.request("initialize", json!({})).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(server_write); // EOF on the client's reader
        let res = tokio::time::timeout(Duration::from_secs(2), req)
            .await
            .expect("must not wait out the 10 s timeout")
            .unwrap();
        assert!(matches!(res, Err(LspClientError::ChannelClosed)), "{res:?}");
    }

    #[test]
    fn parses_rust_analyzer_degraded_status() {
        let s = parse_server_status(&json!({
            "health": "warning",
            "quiescent": true,
            "message": "Failed to read Cargo metadata\n"
        }))
        .unwrap();
        assert_eq!(s.health, ServerHealth::Warning);
        assert!(s.quiescent);
        assert_eq!(s.message.as_deref(), Some("Failed to read Cargo metadata"));
    }

    #[test]
    fn parses_ok_status_without_message() {
        let s = parse_server_status(&json!({ "health": "ok", "quiescent": false })).unwrap();
        assert_eq!(s.health, ServerHealth::Ok);
        assert!(!s.quiescent);
        assert_eq!(s.message, None);
    }

    #[test]
    fn rejects_status_without_quiescent() {
        assert!(parse_server_status(&json!({ "health": "ok" })).is_none());
    }
}
