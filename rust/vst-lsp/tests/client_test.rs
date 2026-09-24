use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use vst_lsp::client::{LspClient, ProgressKind};

async fn read_framed_msg<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Value {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read header line");
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(rest.trim().parse::<usize>().expect("parse content length"));
        }
    }
    let len = content_length.expect("Content-Length header");
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await.expect("read body");
    serde_json::from_slice(&body).expect("parse JSON body")
}

async fn write_framed_msg<W: tokio::io::AsyncWrite + Unpin>(writer: &mut W, val: &Value) {
    let s = val.to_string();
    let frame = format!("Content-Length: {}\r\n\r\n{}", s.len(), s);
    writer.write_all(frame.as_bytes()).await.expect("write frame");
    writer.flush().await.expect("flush frame");
}

#[tokio::test]
async fn test_client_roundtrip_and_server_requests() {
    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);

    let (client, mut progress_rx) = LspClient::new(client_read, client_write);

    // Fake language server task
    let server_task = tokio::spawn(async move {
        let mut reader = BufReader::new(server_read);

        // 1. Expect initialize request
        let init_req = read_framed_msg(&mut reader).await;
        assert_eq!(init_req["method"], "initialize");
        let req_id = init_req["id"].clone();

        // Reply to initialize
        let init_resp = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": { "capabilities": {} }
        });
        write_framed_msg(&mut server_write, &init_resp).await;

        // 2. Expect initialized notification
        let initialized_notif = read_framed_msg(&mut reader).await;
        assert_eq!(initialized_notif["method"], "initialized");

        // 3. Send server-to-client request: client/registerCapability
        let reg_req = json!({
            "jsonrpc": "2.0",
            "id": 100,
            "method": "client/registerCapability",
            "params": { "registrations": [] }
        });
        write_framed_msg(&mut server_write, &reg_req).await;

        // Read client's answer to registerCapability
        let reg_resp = read_framed_msg(&mut reader).await;
        assert_eq!(reg_resp["id"], 100);
        assert_eq!(reg_resp["result"], Value::Null);

        // 4. Send $/progress begin notification
        let progress_begin = json!({
            "jsonrpc": "2.0",
            "method": "$/progress",
            "params": {
                "token": "indexing-token",
                "value": {
                    "kind": "begin",
                    "title": "Indexing project"
                }
            }
        });
        write_framed_msg(&mut server_write, &progress_begin).await;

        // 5. Send $/progress end notification
        let progress_end = json!({
            "jsonrpc": "2.0",
            "method": "$/progress",
            "params": {
                "token": "indexing-token",
                "value": {
                    "kind": "end"
                }
            }
        });
        write_framed_msg(&mut server_write, &progress_end).await;
    });

    let temp_dir = tempfile::tempdir().expect("tempdir");
    let init_result = client.initialize(temp_dir.path(), None).await;
    assert!(init_result.is_ok(), "initialize should succeed");

    // Wait for progress begin
    let first = tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
        .await
        .expect("timeout waiting for progress begin")
        .expect("progress channel open");
    assert_eq!(first.kind, ProgressKind::Begin);
    assert_eq!(first.title.as_deref(), Some("Indexing project"));
    assert_eq!(first.token, json!("indexing-token"));

    // Wait for progress end
    let second = tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
        .await
        .expect("timeout waiting for progress end")
        .expect("progress channel open");
    assert_eq!(second.kind, ProgressKind::End);
    assert_eq!(second.token, json!("indexing-token"));

    server_task.await.expect("server task completed");
}
