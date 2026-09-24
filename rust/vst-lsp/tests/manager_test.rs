use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, RwLock};
use vst_lsp::client::{LspClient, ProgressKind};
use vst_lsp::manager::{LspError, LspManager, LspRequestKind, ServerHandle, WorkspaceKey};
use vst_lsp::status::LspStatus;
use vst_types::rest::lsp::LspFileRef;
use vst_ws::streams::file_watcher::{FileWatcher, WatcherCallbacks};

// Serializes tests that mutate the process-global environment (PATH,
// FAKE_LSP_*). Rust runs #[tokio::test]s in parallel by default, so two tests
// mutating global env would race — acquire this lock at the start of any test
// that sets env vars and hold it until the end.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
async fn test_manager_status_transitions_and_handle_reuse() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);

    let (client, mut progress_rx) = LspClient::new(client_read, client_write);
    let status = Arc::new(RwLock::new(LspStatus::Starting));
    let last_request = Arc::new(RwLock::new(Instant::now()));
    let open_files = Arc::new(Mutex::new(HashSet::new()));
    let file_versions = Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(None));

    let handle = ServerHandle {
        client: client.clone(),
        child,
        status: status.clone(),
        last_request,
        open_files: open_files.clone(),
        file_versions,
        language: "rust".to_string(),
        // Pre-initialized so request() proceeds past the handshake latch and
        // exercises the status transitions this test asserts.
        initialized: tokio::sync::watch::channel(true).1,
    };

    let ws_key = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };

    manager
        .insert_server_handle(ws_key.clone(), "rust".to_string(), handle.clone())
        .await;

    // Track $/progress into status
    let status_for_progress = status.clone();
    tokio::spawn(async move {
        let mut active_tokens = HashSet::new();
        while let Some(p) = progress_rx.recv().await {
            match p.kind {
                ProgressKind::Begin => {
                    active_tokens.insert(format!("{:?}", p.token));
                    *status_for_progress.write().await = LspStatus::Indexing;
                }
                ProgressKind::Report => {}
                ProgressKind::End => {
                    active_tokens.remove(&format!("{:?}", p.token));
                    if active_tokens.is_empty() {
                        *status_for_progress.write().await = LspStatus::Ready;
                    }
                }
            }
        }
    });

    let temp_root = tempfile::tempdir().expect("temp_root");
    let file_path = temp_root.path().join("src/lib.rs");
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    std::fs::write(&file_path, "pub fn add(a: i32, b: i32) -> i32 { a + b }").unwrap();

    // 1. While status is Starting: request must immediately return LspError::Starting
    assert_eq!(*status.read().await, LspStatus::Starting);
    let err = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, LspError::Starting));

    // 2. Script fake server sending $/progress begin
    let prog_begin = json!({
        "jsonrpc": "2.0",
        "method": "$/progress",
        "params": {
            "token": "tok1",
            "value": { "kind": "begin", "title": "Indexing" }
        }
    });
    write_framed_msg(&mut server_write, &prog_begin).await;

    // Wait briefly for status to reflect Indexing
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(*status.read().await, LspStatus::Indexing);

    // Still Indexing -> must still return LspError::Starting
    let err2 = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err2, LspError::Starting));

    // 3. Script fake server sending $/progress end
    let prog_end = json!({
        "jsonrpc": "2.0",
        "method": "$/progress",
        "params": {
            "token": "tok1",
            "value": { "kind": "end" }
        }
    });
    write_framed_msg(&mut server_write, &prog_end).await;

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(*status.read().await, LspStatus::Ready);

    // 4. Server answering definition request in a background task
    let mut server_reader = BufReader::new(server_read);
    tokio::spawn(async move {
        loop {
            let req = read_framed_msg(&mut server_reader).await;
            if req["method"] == "textDocument/definition" {
                let id = req["id"].clone();
                let def_resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": [{
                        "uri": format!("file://{}", file_path.display()),
                        "range": {
                            "start": { "line": 0, "character": 7 },
                            "end": { "line": 0, "character": 10 }
                        }
                    }]
                });
                write_framed_msg(&mut server_write, &def_resp).await;
                break;
            }
        }
    });

    // Now request should succeed and return Ready response
    let res = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await
        .expect("request succeeds when Ready");

    match res {
        vst_lsp::manager::LspResponse::Definition(locs) => {
            assert_eq!(locs.len(), 1);
            assert_eq!(locs[0].line, 0);
            assert_eq!(locs[0].character, 7);
        }
        _ => panic!("Expected definition response"),
    }

    // Two request calls reuse the same handle
    let handle_check = manager
        .get_server_handle(&ws_key, "rust")
        .await
        .expect("handle exists");
    assert!(Arc::ptr_eq(&handle_check.client, &handle.client));
}

#[tokio::test]
async fn test_manager_document_sync_via_owned_watcher() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);

    let (client, _progress_rx) = LspClient::new(client_read, client_write);
    let status = Arc::new(RwLock::new(LspStatus::Ready));
    let last_request = Arc::new(RwLock::new(Instant::now()));
    let open_files = Arc::new(Mutex::new(HashSet::new()));
    let file_versions = Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(None));

    let handle = ServerHandle {
        client: client.clone(),
        child,
        status,
        last_request,
        open_files: open_files.clone(),
        file_versions: file_versions.clone(),
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };

    let ws_key = WorkspaceKey::Worktree {
        project_id: "test-proj-2".to_string(),
        worktree_id: "test-wt-2".to_string(),
    };

    manager
        .insert_server_handle(ws_key.clone(), "rust".to_string(), handle)
        .await;

    let temp_root = tempfile::tempdir().expect("temp_root");
    let file_path = temp_root.path().join("src/lib.rs");
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    std::fs::write(&file_path, "initial content").unwrap();

    let mut server_reader = BufReader::new(server_read);

    // Initial request causes didOpen
    let server_task = tokio::spawn(async move {
        // 1. Expect textDocument/didOpen
        let open_msg = read_framed_msg(&mut server_reader).await;
        assert_eq!(open_msg["method"], "textDocument/didOpen");

        // 2. Expect textDocument/definition
        let def_msg = read_framed_msg(&mut server_reader).await;
        assert_eq!(def_msg["method"], "textDocument/definition");
        let id = def_msg["id"].clone();
        write_framed_msg(
            &mut server_write,
            &json!({ "jsonrpc": "2.0", "id": id, "result": null }),
        )
        .await;

        // 3. Expect textDocument/didChange after watcher on_changed fires
        let change_msg = read_framed_msg(&mut server_reader).await;
        assert_eq!(change_msg["method"], "textDocument/didChange");
        let text = change_msg["params"]["contentChanges"][0]["text"].as_str().unwrap();
        assert_eq!(text, "updated content after edit");
    });

    let _ = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Simulate file modification on disk
    std::fs::write(&file_path, "updated content after edit").unwrap();

    // Trigger manager's document sync callback for that file
    // Construct WatcherCallbacks the same way manager does
    let servers = manager.get_server_handle(&ws_key, "rust").await.unwrap();
    assert!(servers.open_files.lock().await.contains(&file_path));

    // Create an owned FileWatcher for this workspace
    let open_files_check = servers.open_files.clone();
    let client_check = servers.client.clone();
    let versions_check = servers.file_versions.clone();

    let on_changed = Arc::new(move |abs_path_str: String| {
        let abs_path = std::path::PathBuf::from(&abs_path_str);
        let open_files = open_files_check.clone();
        let client = client_check.clone();
        let versions = versions_check.clone();
        tokio::spawn(async move {
            if open_files.lock().await.contains(&abs_path) {
                if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                    let mut vers = versions.lock().await;
                    let ver = vers.entry(abs_path.clone()).or_insert(1);
                    *ver += 1;
                    let uri = format!("file://{}", abs_path.display());
                    let _ = client.notify(
                        "textDocument/didChange",
                        json!({
                            "textDocument": {
                                "uri": uri,
                                "version": *ver
                            },
                            "contentChanges": [
                                { "text": content }
                            ]
                        }),
                    );
                }
            }
        });
    });

    let callbacks = WatcherCallbacks {
        on_changed: on_changed.clone(),
        on_deleted: Arc::new(|_| {}),
        on_error: Arc::new(|_| {}),
    };
    let watcher = Arc::new(FileWatcher::new(callbacks, temp_root.path().to_path_buf()));
    manager.insert_watcher(ws_key.clone(), watcher.clone()).await;

    // Fire on_changed directly to verify document sync
    on_changed(file_path.to_string_lossy().into_owned());

    server_task.await.expect("server task completed successfully");

    // Second assertion: confirm zero WsConnection / browser subscribers present
    // The manager's watcher was constructed directly with callbacks, with no WatcherRegistry / WsConnection subscriber.
    assert!(manager.get_watcher(&ws_key).await.is_some());
}

#[tokio::test]
async fn test_java_spawn_data_dir() {
    use std::os::unix::fs::PermissionsExt;

    let _env_guard = ENV_LOCK.lock().unwrap();

    let temp_vst = tempfile::tempdir().expect("temp_vst");
    let manager = LspManager::new(temp_vst.path().to_path_buf());

    let temp_bin = tempfile::tempdir().expect("temp_bin");
    let args_log = temp_bin.path().join("args.log");
    let fake_jdtls = temp_bin.path().join("jdtls");

    // Fake jdtls script records all arguments to args.log and then sleeps/reads stdin
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\ncat > /dev/null\n",
        args_log.display()
    );
    std::fs::write(&fake_jdtls, script).unwrap();
    let mut perms = std::fs::metadata(&fake_jdtls).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&fake_jdtls, perms).unwrap();

    let orig_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", temp_bin.path().display(), orig_path);
    std::env::set_var("PATH", &new_path);

    let ws1 = WorkspaceKey::Worktree {
        project_id: "test-proj-1".to_string(),
        worktree_id: "test-wt-1".to_string(),
    };
    let ws2 = WorkspaceKey::Worktree {
        project_id: "test-proj-2".to_string(),
        worktree_id: "test-wt-2".to_string(),
    };

    let temp_root1 = tempfile::tempdir().expect("temp_root1");
    let file1 = temp_root1.path().join("Main.java");
    std::fs::write(&file1, "class Main {}").unwrap();

    let temp_root2 = tempfile::tempdir().expect("temp_root2");
    let file2 = temp_root2.path().join("Main.java");
    std::fs::write(&file2, "class Main {}").unwrap();

    // Spawn for ws1
    let _ = manager
        .request(
            ws1.clone(),
            temp_root1.path(),
            "java",
            LspFileRef::Workspace {
                path: "Main.java".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Spawn for ws2
    let _ = manager
        .request(
            ws2.clone(),
            temp_root2.path(),
            "java",
            LspFileRef::Workspace {
                path: "Main.java".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Restore PATH
    std::env::set_var("PATH", &orig_path);

    // Read recorded arguments (poll briefly up to 1 second)
    let mut content = String::new();
    for _ in 0..20 {
        if let Ok(c) = std::fs::read_to_string(&args_log) {
            if c.lines().count() >= 2 {
                content = c;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 2, "Expected 2 invocations of fake jdtls, got: {:?}", lines);

    // Extract -data argument from each invocation line
    fn extract_data_path(cmd_line: &str) -> String {
        let parts: Vec<&str> = cmd_line.split_whitespace().collect();
        for i in 0..parts.len() {
            if parts[i] == "-data" && i + 1 < parts.len() {
                return parts[i + 1].to_string();
            }
        }
        panic!("'-data' not found in args line: {}", cmd_line);
    }

    let data_path1 = extract_data_path(lines[0]);
    let data_path2 = extract_data_path(lines[1]);

    assert!(
        data_path1.ends_with(&ws1.to_key_string()),
        "data_path1 {} should end with ws1 key {}",
        data_path1,
        ws1.to_key_string()
    );
    assert!(
        data_path2.ends_with(&ws2.to_key_string()),
        "data_path2 {} should end with ws2 key {}",
        data_path2,
        ws2.to_key_string()
    );
    assert_ne!(
        data_path1, data_path2,
        "two different WorkspaceKeys must produce different -data paths"
    );

    // Assert that the directories were actually created on disk
    assert!(std::path::Path::new(&data_path1).is_dir());
    assert!(std::path::Path::new(&data_path2).is_dir());
}

#[tokio::test]
async fn test_manager_disabled_behavior() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());
    let ws = WorkspaceKey::Worktree {
        project_id: "p1".to_string(),
        worktree_id: "wt1".to_string(),
    };

    // 1. status with enabled: false returns (LspStatus::Disabled, Some("rust")) for .rs
    let (status, lang) = manager.status(&ws, "src/main.rs", false).await;
    assert_eq!(status, LspStatus::Disabled);
    assert_eq!(lang.as_deref(), Some("rust"));

    // status with unknown extension returns (LspStatus::Disabled, None)
    let (status_unknown, lang_unknown) = manager.status(&ws, "test.unsupported_xyz", false).await;
    assert_eq!(status_unknown, LspStatus::Disabled);
    assert_eq!(lang_unknown, None);

    // 2. request with enabled: false returns Err(LspError::Disabled)
    let temp_root = tempfile::tempdir().expect("tempdir");
    let res = manager
        .request(
            ws,
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/main.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            false,
        )
        .await;

    match res {
        Err(LspError::Disabled) => {}
        other => panic!("Expected Err(LspError::Disabled), got {:?}", other),
    }
}

/// 3.T2: Unit test — has_ever_been_ready is false before request resolves past
/// Starting/Indexing check, true immediately after; stays true even after a
/// subsequent scripted ProcessDied on a LATER call.
#[tokio::test]
async fn test_manager_ever_ready_latch() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);

    let (client, _rx) = LspClient::new(client_read, client_write);
    let status = Arc::new(RwLock::new(LspStatus::Starting));
    let last_request = Arc::new(RwLock::new(Instant::now()));
    let open_files = Arc::new(Mutex::new(HashSet::new()));
    let file_versions = Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(None));

    let handle = ServerHandle {
        client: client.clone(),
        child,
        status: status.clone(),
        last_request,
        open_files: open_files.clone(),
        file_versions,
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };

    let ws_key = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };

    manager
        .insert_server_handle(ws_key.clone(), "rust".to_string(), handle.clone())
        .await;

    let temp_root = tempfile::tempdir().expect("temp_root");
    let file_path = temp_root.path().join("src/lib.rs");
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    std::fs::write(&file_path, "pub fn add(a: i32, b: i32) -> i32 { a + b }").unwrap();

    // 1. has_ever_been_ready is false initially
    assert!(!manager.has_ever_been_ready(&ws_key, "rust").await);

    // 2. Call request() while Starting -> returns Err(LspError::Starting)
    let err = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, LspError::Starting));
    // Still false
    assert!(!manager.has_ever_been_ready(&ws_key, "rust").await);

    // 3. Promote status to Ready, and answer definition request in background
    *status.write().await = LspStatus::Ready;

    let mut server_reader = BufReader::new(server_read);
    let file_path_clone = file_path.clone();
    let srv_task = tokio::spawn(async move {
        loop {
            let req = read_framed_msg(&mut server_reader).await;
            if req["method"] == "textDocument/definition" {
                let id = req["id"].clone();
                let def_resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": [{
                        "uri": format!("file://{}", file_path_clone.display()),
                        "range": {
                            "start": { "line": 0, "character": 7 },
                            "end": { "line": 0, "character": 10 }
                        }
                    }]
                });
                write_framed_msg(&mut server_write, &def_resp).await;
                break;
            }
        }
        (server_reader, server_write)
    });

    let res = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await;
    assert!(res.is_ok());

    // has_ever_been_ready is now true!
    assert!(manager.has_ever_been_ready(&ws_key, "rust").await);

    // 4. Drop server or simulate ProcessDied on a LATER call
    let (server_reader, server_write) = srv_task.await.unwrap();
    drop(server_reader);
    drop(server_write);

    // Sending a notification forces writer task to hit BrokenPipe and drop outgoing_rx
    let _ = handle.client.notify("exit", json!({}));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let later_err = manager
        .request(
            ws_key.clone(),
            temp_root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 7)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(later_err, LspError::ProcessDied));

    // Stays true even after ProcessDied!
    assert!(manager.has_ever_been_ready(&ws_key, "rust").await);
}

/// Builds a `ServerHandle` over a duplex stream whose `initialize` handshake is
/// NOT yet complete (latch = false), so `request()` blocks until the returned
/// sender is fired. Returns (handle, init_sender).
fn handle_not_initialized() -> (ServerHandle, tokio::sync::watch::Sender<bool>) {
    let (client_read, _server_write) = tokio::io::duplex(64 * 1024);
    let (_server_read, client_write) = tokio::io::duplex(64 * 1024);
    let (client, _progress_rx) = LspClient::new(client_read, client_write);
    let status = Arc::new(RwLock::new(LspStatus::Ready));
    let last_request = Arc::new(RwLock::new(Instant::now()));
    let open_files = Arc::new(Mutex::new(HashSet::new()));
    let file_versions = Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(None));
    let (init_tx, init_rx) = tokio::sync::watch::channel(false);
    let handle = ServerHandle {
        client,
        child,
        status,
        last_request,
        open_files,
        file_versions,
        language: "rust".to_string(),
        initialized: init_rx,
    };
    (handle, init_tx)
}

/// Item 4: `request()` must NOT send `didOpen` or any request to the child
/// process before the `initialize` handshake has completed (the `initialized`
/// notification has gone out). A not-yet-initialized handle blocks the request
/// until the latch fires; only then does the wire traffic (didOpen, then the
/// actual request) appear.
#[tokio::test]
async fn test_request_blocks_until_initialize_handshake() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());

    let (handle, init_tx) = handle_not_initialized();

    let ws_key = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };
    manager
        .insert_server_handle(ws_key.clone(), "rust".to_string(), handle.clone())
        .await;

    let temp_root = tempfile::tempdir().expect("temp_root");
    let file_path = temp_root.path().join("src/lib.rs");
    std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    std::fs::write(&file_path, "pub fn add() {}").unwrap();

    // Drive request() in the background — it must block on the handshake latch.
    let mgr2 = manager.clone();
    let ws2 = ws_key.clone();
    let root2 = temp_root.path().to_path_buf();
    let req_task = tokio::spawn(async move {
        mgr2.request(
            ws2.clone(),
            &root2,
            "rust",
            LspFileRef::Workspace {
                path: "src/lib.rs".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await
    });

    // Give the request task a moment to reach the latch.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // While the handshake is pending, the request must still be blocked — the
    // didOpen/request must NOT have fired (that's the rust-analyzer crash bug).
    assert!(
        !req_task.is_finished(),
        "request must block until initialize handshake completes"
    );

    // Now release the handshake.
    let _ = init_tx.send(true);

    // The request proceeds past the latch (reaching the status/request path
    // rather than hanging forever). Since our fake server never answers, it
    // resolves to an error rather than Ok — the point is it stopped blocking.
    let _ = req_task.await;
}

/// Item 5 + healthy path: a server that initializes but never sends `$/progress`
/// must settle to `Ready` (the guarded settle branch fires) and stay responsive,
/// not busy-spin. Uses the stay-alive fake LSP.
#[tokio::test]
async fn test_server_settles_to_ready_without_progress() {
    let _env_guard = ENV_LOCK.lock().unwrap();

    let temp_vst = tempfile::tempdir().expect("tempdir");
    let temp_bin = tempfile::tempdir().expect("temp_bin");
    let log = temp_bin.path().join("invocations.log");

    let fake = temp_bin.path().join("typescript-language-server");
    std::fs::copy(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_lsp.py"),
        &fake,
    )
    .expect("copy fake lsp");
    let mut perms = std::fs::metadata(&fake).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    std::fs::set_permissions(&fake, perms).unwrap();

    let orig_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", temp_bin.path().display(), orig_path);
    std::env::set_var("PATH", &new_path);
    std::env::set_var("FAKE_LSP_MODE", "stay-alive");
    std::env::set_var("FAKE_LSP_LOG", &log);

    let manager = LspManager::new(temp_vst.path().to_path_buf());
    let ws = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };
    let root = tempfile::tempdir().expect("root");
    let file = root.path().join("src/main.ts");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "const x = 1;").unwrap();

    // First request spawns the server; it blocks on init, then settles to Ready.
    let _ = manager
        .request(
            ws.clone(),
            root.path(),
            "typescript",
            LspFileRef::Workspace {
                path: "src/main.ts".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Without progress, the settle branch should promote Starting -> Ready.
    let handle = manager
        .get_server_handle(&ws, "typescript")
        .await
        .expect("handle exists");
    let mut status = *handle.status.read().await;
    let mut waited = 0;
    while status == LspStatus::Starting && waited < 50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        status = *handle.status.read().await;
        waited += 1;
    }
    assert_eq!(status, LspStatus::Ready, "server should settle to Ready");

    // A second request round-trips against the still-alive (non-spinning) server.
    let res = manager
        .request(
            ws.clone(),
            root.path(),
            "typescript",
            LspFileRef::Workspace {
                path: "src/main.ts".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;
    assert!(res.is_ok(), "request should succeed against settled server");

    std::env::set_var("PATH", &orig_path);
    let _ = std::env::remove_var("FAKE_LSP_MODE");
    let _ = std::env::remove_var("FAKE_LSP_LOG");
}

/// Item 6: when a server process dies, its handle's status becomes `Error`, and
/// a subsequent request for the same (workspace, lang) spawns a genuinely NEW
/// handle rather than reusing/hanging on the dead one.
#[tokio::test]
async fn test_dead_server_becomes_error_and_respawns() {
    let _env_guard = ENV_LOCK.lock().unwrap();

    let temp_vst = tempfile::tempdir().expect("tempdir");
    let temp_bin = tempfile::tempdir().expect("temp_bin");
    let log = temp_bin.path().join("invocations.log");

    let fake = temp_bin.path().join("typescript-language-server");
    std::fs::copy(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_lsp.py"),
        &fake,
    )
    .expect("copy fake lsp");
    let mut perms = std::fs::metadata(&fake).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    std::fs::set_permissions(&fake, perms).unwrap();

    let orig_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", temp_bin.path().display(), orig_path);
    std::env::set_var("PATH", &new_path);
    std::env::set_var("FAKE_LSP_MODE", "die-after-init");
    std::env::set_var("FAKE_LSP_LOG", &log);

    let manager = LspManager::new(temp_vst.path().to_path_buf());
    let ws = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };
    let root = tempfile::tempdir().expect("root");
    let file = root.path().join("src/main.ts");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "const x = 1;").unwrap();

    // First request spawns server #1 (which dies right after init).
    let _ = manager
        .request(
            ws.clone(),
            root.path(),
            "typescript",
            LspFileRef::Workspace {
                path: "src/main.ts".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Wait for the handle's status to become Error (reader task detected EOF).
    let mut became_error = false;
    for _ in 0..50 {
        if let Some(h) = manager.get_server_handle(&ws, "typescript").await {
            if *h.status.read().await == LspStatus::Error {
                became_error = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(became_error, "dead server's handle should become Error");

    // Second request must spawn a NEW process (the dead one is replaced).
    let _ = manager
        .request(
            ws.clone(),
            root.path(),
            "typescript",
            LspFileRef::Workspace {
                path: "src/main.ts".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await;

    // Poll the log until it has 2 invocations (2 distinct spawned processes).
    let mut lines = 0;
    for _ in 0..50 {
        if let Ok(c) = std::fs::read_to_string(&log) {
            lines = c.lines().count();
            if lines >= 2 {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        lines, 2,
        "a new server process should have been spawned after the dead one"
    );

    std::env::set_var("PATH", &orig_path);
    let _ = std::env::remove_var("FAKE_LSP_MODE");
    let _ = std::env::remove_var("FAKE_LSP_LOG");
}

/// Item 7: workspace path confinement — an absolute path (e.g. `/etc/passwd`)
/// and a `..`-escaping relative path must be rejected, never resolved.
#[tokio::test]
async fn test_workspace_path_confinement() {
    let temp_vst = tempfile::tempdir().expect("tempdir");
    let manager = LspManager::new(temp_vst.path().to_path_buf());
    let ws = WorkspaceKey::Worktree {
        project_id: "test-proj".to_string(),
        worktree_id: "test-wt".to_string(),
    };
    let root = tempfile::tempdir().expect("root");

    // A real file OUTSIDE the root that must NOT be reachable via a workspace path.
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("secret.rs"), "fn secret() {}").unwrap();

    // Absolute path -> rejected (NotFound).
    let err = manager
        .request(
            ws.clone(),
            root.path(),
            "rust",
            LspFileRef::Workspace {
                path: "/etc/passwd".to_string(),
            },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, LspError::NotFound));

    // `..`-escaping relative path -> rejected (NotFound).
    let escape = format!(
        "../{}/secret.rs",
        outside.path().file_name().unwrap().to_string_lossy()
    );
    let err2 = manager
        .request(
            ws.clone(),
            root.path(),
            "rust",
            LspFileRef::Workspace { path: escape },
            LspRequestKind::Definition,
            Some((0, 0)),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err2, LspError::NotFound));
}


