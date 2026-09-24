//! Integration test for LSP routes (Regression guard for Decision 2).
//!
//! Verifies that `GET /api/worktrees/:id/lsp/status` and
//! `GET /api/projects/:id/lsp/status` resolve root via the EXACT SAME path
//! a parallel `get_file` call resolves (neither calls `resolved_context_of`).

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_git::paths::Paths;
use vst_lsp::{LspManager, WorkspaceKey};
use vst_proc::tmux::Tmux;
use vst_routes::lsp::LspRoutes;
use vst_routes::projects::ProjectRoutes;
use vst_routes::worktrees::WorktreeRoutes;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::lsp::LspFileRef;
use vst_types::{ProjectRecord, WorktreeRecord};

fn init_git_repo(path: &Path) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git command {:?} failed", args);
    };
    run(&["init"]);
    run(&["config", "user.email", "test@test.com"]);
    run(&["config", "user.name", "Test User"]);
}

#[tokio::test]
async fn test_lsp_root_matches_get_file_exactly() {
    // Isolated custom home directory (test seam)
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::new());
    let tmux = Tmux::new();

    let mut worktree_routes = WorktreeRoutes::new(
        store.clone(),
        broadcaster.clone(),
        json_registry.clone(),
        tmux.clone(),
        4000,
    );
    worktree_routes.paths = paths.clone();

    let project_routes = ProjectRoutes::new(
        store.clone(),
        broadcaster,
        json_registry,
        tmux,
        4000,
    )
    .with_paths(paths.clone());

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager);

    // ── Setup Project Fixture ─────────────────────────────────────────────
    let proj_dir = tempdir().unwrap();
    init_git_repo(proj_dir.path());
    let main_rs_path = proj_dir.path().join("main.rs");
    std::fs::write(&main_rs_path, "fn main() { println!(\"project\"); }").unwrap();

    // ── Setup Worktree Fixture ────────────────────────────────────────────
    let wt_id = "wt-100";
    let wt_path = paths.worktree_path("proj-1", wt_id);
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);
    let lib_rs_path = wt_path.join("lib.rs");
    std::fs::write(&lib_rs_path, "pub fn hello() -> &'static str { \"worktree\" }").unwrap();

    let worktree_record = WorktreeRecord {
        id: wt_id.to_string(),
        name: Some("Test WT".to_string()),
        branch: "feature-test".to_string(),
        branch_is_placeholder: Some(false),
        base_branch: "main".to_string(),
        base_sha: "0000000".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        lsp_enabled: Some(true),
        sessions: vec![],
    };

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: proj_dir.path().to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![worktree_record],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };

    store.add_project(project_record).await.unwrap();

    // ── 1. Worktree Session Assertion (Decision 2) ────────────────────────
    // WorktreeRoutes::get_file resolves root via self.paths.worktree_path(&project.id, wt_id)
    let get_file_res = worktree_routes.get_file(wt_id, "lib.rs").await;
    assert!(get_file_res.is_ok(), "worktree get_file must succeed");

    let lsp_wt_root = lsp_routes
        .resolve_workspace_root(&WorkspaceKey::Worktree {
            project_id: "proj-1".to_string(),
            worktree_id: wt_id.to_string(),
        })
        .await
        .expect("resolve_workspace_root for worktree succeeds");

    // Root must match the worktree directory get_file used
    assert_eq!(lsp_wt_root, wt_path);

    let wt_status = lsp_routes
        .status(
            WorkspaceKey::Worktree {
                project_id: "proj-1".to_string(),
                worktree_id: wt_id.to_string(),
            },
            "lib.rs",
        )
        .await
        .expect("worktree lsp status succeeds");
    assert_eq!(wt_status.language.as_deref(), Some("rust"));

    // ── 2. Project Direct Session Assertion (Decision 2) ──────────────────
    // ProjectRoutes::get_file resolves root via Path::new(&project.absolute_path)
    let proj_get_file_res = project_routes.get_file("proj-1", "main.rs").await;
    assert!(proj_get_file_res.is_ok(), "project get_file must succeed");

    let lsp_proj_root = lsp_routes
        .resolve_workspace_root(&WorkspaceKey::Project {
            project_id: "proj-1".to_string(),
        })
        .await
        .expect("resolve_workspace_root for project succeeds");

    // Root must match the project absolute path get_file used
    assert_eq!(lsp_proj_root, proj_dir.path());

    let proj_status = lsp_routes
        .status(
            WorkspaceKey::Project {
                project_id: "proj-1".to_string(),
            },
            "main.rs",
        )
        .await
        .expect("project lsp status succeeds");
    assert_eq!(proj_status.language.as_deref(), Some("rust"));

    // ── 3. Stub endpoints return Unsupported in Phase 1 ───────────────────
    let def_err = lsp_routes
        .definition(
            WorkspaceKey::Worktree {
                project_id: "proj-1".to_string(),
                worktree_id: wt_id.to_string(),
            },
            LspFileRef::Workspace {
                path: "unknown.xyz".to_string(),
            },
            0,
            0,
        )
        .await
        .unwrap_err();
    assert!(matches!(def_err, vst_routes::lsp::LspRouteError::Unsupported(_)));
}

#[tokio::test]
async fn test_4_t1_token_minting() {
    // 4.T1 Unit — token minting: an external Location gets a token; a workspace-internal Location does not;
    // re-resolving the same canonical external path twice reuses the same token.
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    // External file outside workspace
    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("ext.rs");
    std::fs::write(&ext_file, "pub fn ext() {}").unwrap();
    let canon_ext = ext_file.canonicalize().unwrap();

    // Mint token twice for canonical external path
    let token1 = lsp_manager.get_or_mint_external_token(&ws, &canon_ext).await;
    assert!(!token1.is_empty(), "Token must not be empty");

    let token2 = lsp_manager.get_or_mint_external_token(&ws, &canon_ext).await;
    assert_eq!(token1, token2, "Re-resolving the same canonical external path twice must reuse the same token");

    // Resolving token gives back the canonical path
    let resolved = lsp_manager.resolve_external_token(&ws, &token1).await;
    assert_eq!(resolved, Some(canon_ext.clone()));

    // Setup worktree in store
    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);
    let internal_file = wt_path.join("lib.rs");
    std::fs::write(&internal_file, "pub fn internal() {}").unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    // Mock a ServerHandle that returns definition results (one internal, one external)
    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);
    let (client, _rx) = vst_lsp::LspClient::new(client_read, client_write);

    let handle = vst_lsp::ServerHandle {
        client,
        child: Arc::new(tokio::sync::Mutex::new(None)),
        status: Arc::new(tokio::sync::RwLock::new(vst_types::rest::lsp::LspStatus::Ready)),
        last_request: Arc::new(tokio::sync::RwLock::new(std::time::Instant::now())),
        open_files: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
        file_versions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };
    lsp_manager.insert_server_handle(ws.clone(), "rust".to_string(), handle).await;

    let canon_ext_clone = canon_ext.clone();
    let internal_file_clone = internal_file.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let mut reader = BufReader::new(server_read);
        loop {
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 { return; }
                let trimmed = line.trim();
                if trimmed.is_empty() { break; }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).await.unwrap();
            let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if val.get("method").and_then(|m| m.as_str()) == Some("textDocument/definition") {
                let req_id = val["id"].clone();

                let resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": [
                        {
                            "uri": format!("file://{}", internal_file_clone.canonicalize().unwrap().display()),
                            "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 0, "character": 12 } }
                        },
                        {
                            "uri": format!("file://{}", canon_ext_clone.display()),
                            "range": { "start": { "line": 0, "character": 7 }, "end": { "line": 0, "character": 10 } }
                        }
                    ]
                });
                let s = resp.to_string();
                let frame = format!("Content-Length: {}\r\n\r\n{}", s.len(), s);
                server_write.write_all(frame.as_bytes()).await.unwrap();
                server_write.flush().await.unwrap();
                break;
            }
        }
    });

    let def_resp = lsp_routes
        .definition(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 4)
        .await
        .expect("definition succeeds");

    assert_eq!(def_resp.locations.len(), 2);

    // 1. Internal Location: external is false, path is Some("lib.rs"), token is None
    let loc_internal = &def_resp.locations[0];
    assert!(!loc_internal.external);
    assert_eq!(loc_internal.path.as_deref(), Some("lib.rs"));
    assert_eq!(loc_internal.token, None);
    assert_eq!(loc_internal.display_path, None);

    // 2. External Location: external is true, path is None, token is populated, display_path is populated
    let loc_external = &def_resp.locations[1];
    assert!(loc_external.external);
    assert_eq!(loc_external.path, None);
    assert_eq!(loc_external.token, Some(token1.clone()));
    assert_eq!(loc_external.display_path, Some(canon_ext.to_string_lossy().to_string()));
    assert_eq!(loc_internal.confidence, "lsp");
    assert_eq!(loc_external.confidence, "lsp");
}

#[tokio::test]
async fn test_4_t2_external_file_serving_and_bogus_token() {
    // 4.T2 Integration — GET /worktrees/:id/lsp/external-file/:token:
    // valid token returns content matching read_file_response's shape;
    // bogus token returns 404 LSP_EXTERNAL_TOKEN_EXPIRED.
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    // Create an external file
    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("external_lib.rs");
    let content = "pub fn external_feature() -> bool { true }\n";
    std::fs::write(&ext_file, content).unwrap();
    let canon_ext = ext_file.canonicalize().unwrap();

    let token = lsp_manager.get_or_mint_external_token(&ws, &canon_ext).await;

    // 1. Valid token returns FileResponse::Text with matching content and etag
    let resp = lsp_routes.external_file(ws.clone(), &token).await.expect("valid token succeeds");
    match resp {
        vst_routes::file_serving::FileResponse::Text { etag, content: text_content } => {
            assert_eq!(text_content, content);
            assert!(!etag.is_empty());
        }
        _ => panic!("Expected FileResponse::Text"),
    }

    // 2. Bogus token returns 404 LSP_EXTERNAL_TOKEN_EXPIRED
    let err = lsp_routes.external_file(ws.clone(), "bogus-token-does-not-exist").await.unwrap_err();
    let (status, body) = vst_routes::lsp::lsp_err_to_response(err);
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(body.0["code"], "LSP_EXTERNAL_TOKEN_EXPIRED");
}

#[tokio::test]
async fn test_4_t3_security_percent_encoded_path_traversal_is_opaque_token() {
    // 4.T3 Security regression — GET /worktrees/:id/lsp/external-file/%2E%2E%2Fetc%2Fpasswd
    // is treated as an unknown opaque token string (never filesystem-interpreted) → 404 LSP_EXTERNAL_TOKEN_EXPIRED
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager);

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    // Call external_file with percent-encoded path traversal token
    let err = lsp_routes.external_file(ws.clone(), "%2E%2E%2Fetc%2Fpasswd").await.unwrap_err();
    let (status, body) = vst_routes::lsp::lsp_err_to_response(err);
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(body.0["code"], "LSP_EXTERNAL_TOKEN_EXPIRED");

    // Also test with raw percent-decoded segment
    let err2 = lsp_routes.external_file(ws, "..%2Fetc%2Fpasswd").await.unwrap_err();
    let (status2, body2) = vst_routes::lsp::lsp_err_to_response(err2);
    assert_eq!(status2, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(body2.0["code"], "LSP_EXTERNAL_TOKEN_EXPIRED");
}

#[tokio::test]
async fn test_4_t4_security_symlink_to_deny_listed_prefix_rejected() {
    // 4.T4 Security regression — a symlink whose canonicalized target resolves under /etc/
    // (one of 4.0(d)'s deny-listed prefixes) is rejected, even though it would pass the
    // is_file() check on its own (/etc/passwd is a regular file) — asserts the deny-list check
    // specifically, not just canonicalize+is_file, is what catches this case.
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    // Create a symlink in a tempdir pointing to /etc/passwd
    let temp = tempdir().unwrap();
    let symlink_path = temp.path().join("passwd_symlink");

    let target = Path::new("/etc/passwd");
    if target.exists() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &symlink_path).unwrap();

        // 1. Verify symlink target IS a regular file (would pass is_file() on its own!)
        let canon = symlink_path.canonicalize().expect("symlink canonicalizes to target");
        assert!(canon.is_file(), "Canonicalized target /etc/passwd IS a regular file!");

        // 2. But is_sensitive_path specifically flags it
        assert!(
            vst_lsp::is_sensitive_path(&canon, Some(paths.vst_home())),
            "is_sensitive_path must flag /etc/passwd as deny-listed"
        );

        // 3. Even if inserted into token map, external_file rejects it
        lsp_manager.insert_external_token(ws.clone(), "symlink-token".to_string(), symlink_path).await;
        let err = lsp_routes.external_file(ws, "symlink-token").await.unwrap_err();
        let (status, body) = vst_routes::lsp::lsp_err_to_response(err);
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body.0["code"], "LSP_EXTERNAL_TOKEN_EXPIRED");
    }
}

#[tokio::test]
async fn test_5_t1_references_pagination() {
    // 5.T1 Unit — LspRoutes::references pagination: a 120-entry mocked response is served
    // as 50/50/20 pages with correct cursor chaining.
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let mut lines = Vec::new();
    for i in 0..120 {
        lines.push(format!("pub fn func_{i}() {{}}"));
    }
    let content = lines.join("\n");
    let lib_rs = wt_path.join("lib.rs");
    std::fs::write(&lib_rs, &content).unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);
    let (client, _rx) = vst_lsp::LspClient::new(client_read, client_write);

    let handle = vst_lsp::ServerHandle {
        client,
        child: Arc::new(tokio::sync::Mutex::new(None)),
        status: Arc::new(tokio::sync::RwLock::new(vst_types::rest::lsp::LspStatus::Ready)),
        last_request: Arc::new(tokio::sync::RwLock::new(std::time::Instant::now())),
        open_files: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
        file_versions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };
    lsp_manager.insert_server_handle(ws.clone(), "rust".to_string(), handle).await;

    let lib_rs_canon = lib_rs.canonicalize().unwrap();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let mut reader = BufReader::new(server_read);
        loop {
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 { return; }
                let trimmed = line.trim();
                if trimmed.is_empty() { break; }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).await.unwrap();
            let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if val.get("method").and_then(|m| m.as_str()) == Some("textDocument/references") {
                let req_id = val["id"].clone();
                let mut locs = Vec::new();
                for i in 0..120 {
                    locs.push(serde_json::json!({
                        "uri": format!("file://{}", lib_rs_canon.display()),
                        "range": {
                            "start": { "line": i, "character": 4 },
                            "end": { "line": i, "character": 10 }
                        },
                        "isDeclaration": i == 0
                    }));
                }
                let resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": locs
                });
                let s = resp.to_string();
                let frame = format!("Content-Length: {}\r\n\r\n{}", s.len(), s);
                server_write.write_all(frame.as_bytes()).await.unwrap();
                server_write.flush().await.unwrap();
            }
        }
    });

    // Page 1 (offset 0): 50 entries
    let res1 = lsp_routes
        .references(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 4, None)
        .await
        .expect("page 1 succeeds");
    let total_entries1: usize = res1.references.iter().map(|g| g.entries.len()).sum();
    assert_eq!(total_entries1, 50);
    assert!(res1.has_more);
    assert_eq!(res1.cursor, Some("50".to_string()));
    assert_eq!(res1.references[0].entries[0].is_declaration, true);

    // Page 2 (offset 50): 50 entries
    let res2 = lsp_routes
        .references(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 4, res1.cursor)
        .await
        .expect("page 2 succeeds");
    let total_entries2: usize = res2.references.iter().map(|g| g.entries.len()).sum();
    assert_eq!(total_entries2, 50);
    assert!(res2.has_more);
    assert_eq!(res2.cursor, Some("100".to_string()));

    // Page 3 (offset 100): 20 entries
    let res3 = lsp_routes
        .references(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 4, res2.cursor)
        .await
        .expect("page 3 succeeds");
    let total_entries3: usize = res3.references.iter().map(|g| g.entries.len()).sum();
    assert_eq!(total_entries3, 20);
    assert!(!res3.has_more);
    assert_eq!(res3.cursor, None);
}

#[tokio::test]
async fn test_5_hover_signature_and_doc() {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let lib_rs = wt_path.join("lib.rs");
    std::fs::write(&lib_rs, "pub fn run() {}").unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            sessions: vec![],
            lsp_enabled: Some(true),
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);
    let (client, _rx) = vst_lsp::LspClient::new(client_read, client_write);

    let handle = vst_lsp::ServerHandle {
        client,
        child: Arc::new(tokio::sync::Mutex::new(None)),
        status: Arc::new(tokio::sync::RwLock::new(vst_types::rest::lsp::LspStatus::Ready)),
        last_request: Arc::new(tokio::sync::RwLock::new(std::time::Instant::now())),
        open_files: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
        file_versions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };
    lsp_manager.insert_server_handle(ws.clone(), "rust".to_string(), handle).await;

    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let mut reader = BufReader::new(server_read);
        loop {
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 { return; }
                let trimmed = line.trim();
                if trimmed.is_empty() { break; }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).await.unwrap();
            let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if val.get("method").and_then(|m| m.as_str()) == Some("textDocument/hover") {
                let req_id = val["id"].clone();
                let resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "contents": {
                            "kind": "markdown",
                            "value": "```rust\npub fn run(cfg: Config) -> Result<(), Error>\n```\n\n---\n\nRuns the app with the given config."
                        }
                    }
                });
                let s = resp.to_string();
                let frame = format!("Content-Length: {}\r\n\r\n{}", s.len(), s);
                server_write.write_all(frame.as_bytes()).await.unwrap();
                server_write.flush().await.unwrap();
                break;
            }
        }
    });

    let hover_res = lsp_routes
        .hover(ws, LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 7)
        .await
        .expect("hover succeeds");

    match hover_res {
        vst_types::rest::lsp::LspHoverResponse::Found { signature, doc } => {
            assert_eq!(signature, "pub fn run(cfg: Config) -> Result<(), Error>");
            assert_eq!(doc.as_deref(), Some("Runs the app with the given config."));
        }
        vst_types::rest::lsp::LspHoverResponse::Empty { .. } => {
            panic!("Expected Found variant");
        }
    }
}

#[test]
fn test_outline_symbol_kind_mapping() {
    use vst_routes::lsp::symbol_kind_to_string;
    assert_eq!(symbol_kind_to_string(12), "function");
    assert_eq!(symbol_kind_to_string(5), "class");
    assert_eq!(symbol_kind_to_string(6), "method");
    assert_eq!(symbol_kind_to_string(13), "variable");
}

#[tokio::test]
async fn test_outline_unsupported_file() {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let project_dir = home_dir.path().join("projects").join("test-proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    init_git_repo(&project_dir);

    let project_record = ProjectRecord {
        id: "p1".to_string(),
        absolute_path: project_dir.to_str().unwrap().to_string(),
        prefix: "P1".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };

    store.add_project(project_record).await.unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager);

    let res = lsp_routes
        .outline(
            WorkspaceKey::Project { project_id: "p1".to_string() },
            "workspace:test.unsupported_ext".to_string(),
        )
        .await
        .unwrap();

    match res {
        vst_types::rest::lsp::LspOutlineResponse::Unsupported { unsupported } => {
            assert!(unsupported);
        }
        _ => panic!("Expected unsupported variant for unsupported file extension"),
    }
}

#[test]
fn test_parse_outline_response_hierarchical() {
    use vst_routes::lsp::parse_outline_response;
    use vst_types::rest::lsp::LspOutlineResponse;

    let json = serde_json::json!([
        {
            "name": "MyClass",
            "kind": 5,
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 50, "character": 1 }
            },
            "selectionRange": {
                "start": { "line": 0, "character": 6 },
                "end": { "line": 0, "character": 13 }
            },
            "children": [
                {
                    "name": "my_method",
                    "kind": 6,
                    "range": {
                        "start": { "line": 10, "character": 4 },
                        "end": { "line": 20, "character": 5 }
                    },
                    "children": []
                }
            ]
        },
        {
            "name": "my_func",
            "kind": 12,
            "range": {
                "start": { "line": 52, "character": 0 },
                "end": { "line": 60, "character": 1 }
            }
        }
    ]);

    let res = parse_outline_response(json);
    match res {
        LspOutlineResponse::Symbols { symbols } => {
            assert_eq!(symbols.len(), 2);
            assert_eq!(symbols[0].name, "MyClass");
            assert_eq!(symbols[0].kind, "class");
            assert_eq!(symbols[0].line, 0);
            assert_eq!(symbols[0].end_line, 50);
            assert_eq!(symbols[0].children.len(), 1);
            assert_eq!(symbols[0].children[0].name, "my_method");
            assert_eq!(symbols[0].children[0].kind, "method");
            assert_eq!(symbols[0].children[0].line, 10);
            assert_eq!(symbols[0].children[0].end_line, 20);

            assert_eq!(symbols[1].name, "my_func");
            assert_eq!(symbols[1].kind, "function");
            assert_eq!(symbols[1].line, 52);
            assert_eq!(symbols[1].end_line, 60);
        }
        _ => panic!("Expected symbols variant"),
    }
}

#[test]
fn test_parse_outline_response_sorts_out_of_order_symbols_by_position() {
    // `textDocument/documentSymbol` order is NOT guaranteed to match source
    // order by the LSP spec — this response is deliberately out of order
    // (both top-level and within a class's children) to prove the parser
    // sorts by (line, character) rather than trusting server order.
    use vst_routes::lsp::parse_outline_response;
    use vst_types::rest::lsp::LspOutlineResponse;

    let json = serde_json::json!([
        {
            "name": "late_func",
            "kind": 12,
            "range": { "start": { "line": 60, "character": 0 }, "end": { "line": 65, "character": 1 } }
        },
        {
            "name": "MyClass",
            "kind": 5,
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 50, "character": 1 } },
            "children": [
                {
                    "name": "second_method",
                    "kind": 6,
                    "range": { "start": { "line": 20, "character": 4 }, "end": { "line": 25, "character": 5 } }
                },
                {
                    "name": "first_method",
                    "kind": 6,
                    "range": { "start": { "line": 5, "character": 4 }, "end": { "line": 10, "character": 5 } }
                }
            ]
        },
        {
            "name": "early_var",
            "kind": 13,
            "range": { "start": { "line": 55, "character": 0 }, "end": { "line": 55, "character": 10 } }
        }
    ]);

    let res = parse_outline_response(json);
    match res {
        LspOutlineResponse::Symbols { symbols } => {
            let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(names, vec!["MyClass", "early_var", "late_func"]);

            let child_names: Vec<&str> =
                symbols[0].children.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(child_names, vec!["first_method", "second_method"]);
        }
        _ => panic!("Expected symbols variant"),
    }
}

#[tokio::test]
async fn test_lsp_disabled_worktree_status_and_definition() {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);
    let internal_file = wt_path.join("lib.rs");
    std::fs::write(&internal_file, "pub fn internal() {}").unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(false), // Disabled!
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager);

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    // 1. GET status for lib.rs returns status: disabled, language: rust
    let status_resp = lsp_routes.status(ws.clone(), "lib.rs").await.unwrap();
    assert_eq!(status_resp.status, vst_types::rest::lsp::LspStatus::Disabled);
    assert_eq!(status_resp.language.as_deref(), Some("rust"));

    // 2. Definition request returns Err(LspRouteError::Disabled)
    let def_err = lsp_routes
        .definition(
            ws,
            LspFileRef::Workspace {
                path: "lib.rs".to_string(),
            },
            0,
            3,
        )
        .await
        .unwrap_err();

    match def_err {
        vst_routes::lsp::LspRouteError::Disabled => {}
        other => panic!("Expected LspRouteError::Disabled, got {:?}", other),
    }

    // 3. Verify HTTP mapping produces 409 Conflict with code LSP_DISABLED
    let (status_code, json_val) = vst_routes::lsp::lsp_err_to_response(def_err);
    assert_eq!(status_code, axum::http::StatusCode::CONFLICT);
    assert_eq!(json_val["code"], "LSP_DISABLED");
}

#[tokio::test]
async fn test_3_t3_definition_fallback_while_starting_then_lsp_when_ready() {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);
    let internal_file = wt_path.join("lib.rs");
    std::fs::write(&internal_file, "pub fn internal() {}\n").unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    let (client_read, mut server_write) = tokio::io::duplex(64 * 1024);
    let (server_read, client_write) = tokio::io::duplex(64 * 1024);
    let (client, _rx) = vst_lsp::LspClient::new(client_read, client_write);

    let status_arc = Arc::new(tokio::sync::RwLock::new(vst_types::rest::lsp::LspStatus::Starting));
    let handle = vst_lsp::ServerHandle {
        client,
        child: Arc::new(tokio::sync::Mutex::new(None)),
        status: status_arc.clone(),
        last_request: Arc::new(tokio::sync::RwLock::new(std::time::Instant::now())),
        open_files: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
        file_versions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        language: "rust".to_string(),
        initialized: tokio::sync::watch::channel(true).1,
    };
    lsp_manager.insert_server_handle(ws.clone(), "rust".to_string(), handle).await;

    let internal_file_clone = internal_file.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let mut reader = BufReader::new(server_read);
        loop {
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 { return; }
                let trimmed = line.trim();
                if trimmed.is_empty() { break; }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    content_length = rest.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).await.unwrap();
            let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if val.get("method").and_then(|m| m.as_str()) == Some("textDocument/definition") {
                let req_id = val["id"].clone();
                let resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": [
                        {
                            "uri": format!("file://{}", internal_file_clone.canonicalize().unwrap().display()),
                            "range": { "start": { "line": 0, "character": 7 }, "end": { "line": 0, "character": 15 } }
                        }
                    ]
                });
                let s = resp.to_string();
                let frame = format!("Content-Length: {}\r\n\r\n{}", s.len(), s);
                server_write.write_all(frame.as_bytes()).await.unwrap();
                server_write.flush().await.unwrap();
            }
        }
    });

    // 1. First call while Starting -> returns fallback text match
    let resp1 = lsp_routes
        .definition(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 7)
        .await
        .expect("fallback definition succeeds");
    assert_eq!(resp1.locations.len(), 1);
    assert_eq!(resp1.locations[0].confidence, "text");
    assert_eq!(resp1.locations[0].path.as_deref(), Some("lib.rs"));

    // 2. Transition status to Ready
    {
        let mut s = status_arc.write().await;
        *s = vst_types::rest::lsp::LspStatus::Ready;
    }

    // 3. Second call after Ready -> returns LSP match
    let resp2 = lsp_routes
        .definition(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 7)
        .await
        .expect("lsp definition succeeds");
    assert_eq!(resp2.locations.len(), 1);
    assert_eq!(resp2.locations[0].confidence, "lsp");
    assert_eq!(resp2.locations[0].path.as_deref(), Some("lib.rs"));
}

#[tokio::test]
async fn test_3_t4_definition_fallback_when_disabled() {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-1".to_string(),
        worktree_id: "wt-100".to_string(),
    };

    let wt_path = paths.worktree_path("proj-1", "wt-100");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);
    let internal_file = wt_path.join("lib.rs");
    std::fs::write(&internal_file, "pub fn internal() {}\n").unwrap();

    let project_record = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-100".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(false), // Disabled
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(false),
    };
    store.add_project(project_record).await.unwrap();

    // Definition on symbol "internal" (col 7) returns fallback text match
    let resp = lsp_routes
        .definition(ws.clone(), LspFileRef::Workspace { path: "lib.rs".to_string() }, 0, 7)
        .await
        .expect("fallback definition succeeds when disabled");
    assert_eq!(resp.locations.len(), 1);
    assert_eq!(resp.locations[0].confidence, "text");
    assert_eq!(resp.locations[0].path.as_deref(), Some("lib.rs"));

    // has_ever_been_ready remains false
    assert!(!lsp_manager.has_ever_been_ready(&ws, "rust").await);
}

#[tokio::test]
async fn test_statuses_route_lists_only_languages_detected_in_the_file_tree() {
    // Mirrors the shape of the existing `/lsp/status` route tests above, but
    // for the new read-only `GET /lsp/statuses` endpoint: it should surface
    // one entry per language actually present in the workspace's file tree
    // (not every language `LspManager` happens to have a `ServerHandle`
    // for) — a handle inserted for a language with NO matching file in the
    // tree must NOT appear in the result.
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();

    let lsp_manager = LspManager::new(paths.vst_home().clone());
    let lsp_routes = LspRoutes::new(store.clone(), paths.clone(), lsp_manager.clone());

    let wt_path = paths.worktree_path("proj-statuses", "wt-statuses");
    std::fs::create_dir_all(&wt_path).unwrap();
    init_git_repo(&wt_path);

    let project_record = ProjectRecord {
        id: "proj-statuses".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-statuses".to_string(),
            name: Some("Test WT".to_string()),
            branch: "feature-test".to_string(),
            branch_is_placeholder: Some(false),
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(1),
            agent_seq: Some(1),
            lsp_enabled: Some(true),
            sessions: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
    };
    store.add_project(project_record).await.unwrap();

    let ws = WorkspaceKey::Worktree {
        project_id: "proj-statuses".to_string(),
        worktree_id: "wt-statuses".to_string(),
    };
    let other_ws = WorkspaceKey::Worktree {
        project_id: "proj-other".to_string(),
        worktree_id: "wt-other".to_string(),
    };

    // No source files in the tree yet: statuses is naturally empty, no error.
    let empty = lsp_routes.statuses(ws.clone()).await.expect("statuses succeeds with no files");
    assert!(empty.is_empty());

    // Real files so the file-tree scan actually detects rust + typescript.
    std::fs::write(wt_path.join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(wt_path.join("app.ts"), "export const x = 1;\n").unwrap();

    let make_handle = |language: &str, status: vst_types::rest::lsp::LspStatus| {
        let (client_read, _sw) = tokio::io::duplex(1024);
        let (_sr, client_write) = tokio::io::duplex(1024);
        let (client, _progress_rx) = vst_lsp::LspClient::new(client_read, client_write);
        vst_lsp::ServerHandle {
            client,
            child: Arc::new(tokio::sync::Mutex::new(None)),
            status: Arc::new(tokio::sync::RwLock::new(status)),
            last_request: Arc::new(tokio::sync::RwLock::new(std::time::Instant::now())),
            open_files: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            file_versions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            language: language.to_string(),
            initialized: tokio::sync::watch::channel(true).1,
        }
    };

    lsp_manager
        .insert_server_handle(
            ws.clone(),
            "rust".to_string(),
            make_handle("rust", vst_types::rest::lsp::LspStatus::Ready),
        )
        .await;
    lsp_manager
        .insert_server_handle(
            ws.clone(),
            "typescript".to_string(),
            make_handle("typescript", vst_types::rest::lsp::LspStatus::Starting),
        )
        .await;
    // A handle for a language with NO matching file in the tree must NOT
    // appear in the result, even though `LspManager` is tracking it.
    lsp_manager
        .insert_server_handle(
            ws.clone(),
            "go".to_string(),
            make_handle("go", vst_types::rest::lsp::LspStatus::Ready),
        )
        .await;
    // A DIFFERENT workspace's handle must not leak into this workspace's list either.
    lsp_manager
        .insert_server_handle(
            other_ws.clone(),
            "python".to_string(),
            make_handle("python", vst_types::rest::lsp::LspStatus::Ready),
        )
        .await;

    let mut statuses = lsp_routes.statuses(ws.clone()).await.expect("statuses succeeds");
    statuses.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        statuses,
        vec![
            ("rust".to_string(), vst_types::rest::lsp::LspStatus::Ready),
            ("typescript".to_string(), vst_types::rest::lsp::LspStatus::Starting),
        ]
    );

    // Unknown workspace: resolve_workspace_root fails -> NotFound, not a panic.
    let unknown_ws = WorkspaceKey::Worktree {
        project_id: "nope".to_string(),
        worktree_id: "nope".to_string(),
    };
    let err = lsp_routes.statuses(unknown_ws).await.unwrap_err();
    assert!(matches!(err, vst_routes::lsp::LspRouteError::NotFound(_)));
}



