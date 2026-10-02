//! Contract tests for latched LSP start failures at the route layer: status
//! `failure` + presentation, the 503 `LSP_SERVER_FAILED` body, the
//! `server_failed` text fallback, and `restart`.
//!
//! Own test binary because it puts a stub `typescript-language-server` on
//! `$PATH` (process-global).

use std::path::Path;
use std::process::Command;

use axum::http::StatusCode;
use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_lsp::{LspManager, WorkspaceKey};
use vst_routes::lsp::{lsp_err_to_response, LspRouteError, LspRoutes};
use vst_store::StoreHandle;
use vst_types::rest::lsp::{
    LspAction, LspFailureKind, LspFallbackReason, LspFileRef, LspRemediationKind, LspSeverity,
    LspStatus,
};
use vst_types::{ProjectRecord, WorktreeRecord};

fn install_ts7(dir: &Path) {
    let pkg = dir.join("node_modules/typescript");
    std::fs::create_dir_all(pkg.join("lib")).unwrap();
    std::fs::write(pkg.join("package.json"), r#"{ "version": "7.0.2" }"#).unwrap();
    std::fs::write(pkg.join("lib/typescript.js"), "").unwrap();
}

fn project(wt_path: &Path) -> ProjectRecord {
    ProjectRecord {
        id: "proj-ts".to_string(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "PRJ".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-ts".to_string(),
            name: Some("TS".to_string()),
            branch: "feature".to_string(),
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
            open_files: vec![],
        }],
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        next_worktree_num: Some(1),
        lsp_enabled: Some(true),
        open_files: vec![],
    }
}

#[tokio::test]
async fn ts7_workspace_reports_setup_needed_503_and_server_failed_fallback() {
    // A stub server binary: the probe only needs it on PATH (it never runs —
    // the Incompatible probe result short-circuits the spawn).
    let bin = tempdir().unwrap();
    let stub = bin.path().join("typescript-language-server");
    std::fs::write(&stub, "#!/bin/sh\necho spawned >> \"$0.log\"\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let orig_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{}", bin.path().display(), orig_path));

    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();
    let wt_path = paths.worktree_path("proj-ts", "wt-ts");
    std::fs::create_dir_all(wt_path.join("src")).unwrap();
    let status = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&wt_path)
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::write(
        wt_path.join("src/a.ts"),
        "export function greet() {}\ngreet();\n",
    )
    .unwrap();
    install_ts7(&wt_path);
    store.add_project(project(&wt_path)).await.unwrap();

    let manager = LspManager::new(paths.vst_home().clone());
    manager.set_npm_global_root(None);
    let routes = LspRoutes::new(store.clone(), paths.clone(), manager);
    let ws = WorkspaceKey::Worktree {
        project_id: String::new(),
        worktree_id: "wt-ts".to_string(),
    };
    let file = || LspFileRef::Workspace {
        path: "src/a.ts".to_string(),
    };

    // No-fallback route (outline): 503 with the failure body.
    let err = routes
        .outline(ws.clone(), "src/a.ts".to_string())
        .await
        .unwrap_err();
    assert!(matches!(err, LspRouteError::Failed(_)), "{err:?}");
    let (code, axum::Json(body)) = lsp_err_to_response(err);
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "LSP_SERVER_FAILED");
    assert_eq!(body["failure"]["kind"], "incompatible_dependency");
    assert_eq!(body["error"], body["failure"]["summary"]);
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("TypeScript 7.0.2 has no tsserver"));

    // Hover: same.
    let err = routes.hover(ws.clone(), file(), 1, 1).await.unwrap_err();
    assert!(matches!(err, LspRouteError::Failed(_)));

    // Definition / references: text fallback tagged server_failed.
    let def = routes.definition(ws.clone(), file(), 1, 1).await.unwrap();
    assert_eq!(
        def.fallback.map(|f| f.reason),
        Some(LspFallbackReason::ServerFailed)
    );
    assert!(def.locations.iter().any(|l| l.line == 0));
    let refs = routes
        .references(ws.clone(), file(), 1, 1, None)
        .await
        .unwrap();
    assert_eq!(
        refs.fallback.map(|f| f.reason),
        Some(LspFallbackReason::ServerFailed)
    );

    // Status: Error + failure, presented as "Setup needed" (warn) with Retry.
    let st = routes.status(ws.clone(), "src/a.ts").await.unwrap();
    assert_eq!(st.status, LspStatus::Error);
    let failure = st.failure.clone().expect("failure on status");
    assert_eq!(failure.kind, LspFailureKind::IncompatibleDependency);
    assert_eq!(st.presentation.label, "Setup needed");
    assert_eq!(st.presentation.severity, LspSeverity::Warn);
    assert_eq!(st.presentation.action, Some(LspAction::Retry));
    assert_eq!(st.presentation.detail, failure.summary);
    assert!(st.degraded.is_none(), "never failure + degraded");
    let kinds: Vec<_> = failure.remediation.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        [LspRemediationKind::CopyCommand, LspRemediationKind::Retry]
    );
    let json = serde_json::to_value(&st).unwrap();
    assert_eq!(
        json["failure"]["remediation"][0]["command"],
        "npm i -D \"typescript@<7\""
    );

    // Per-language statuses carry it too.
    let statuses = routes.statuses(ws.clone()).await.unwrap();
    let ts = statuses
        .iter()
        .find(|s| s.language == "typescript")
        .expect("typescript detected");
    assert_eq!(ts.presentation.label, "Setup needed");
    assert_eq!(
        ts.failure.as_ref().map(|f| f.kind),
        Some(LspFailureKind::IncompatibleDependency)
    );

    // Restart: still incompatible (structural), answered without a spawn.
    let st = routes.restart(ws.clone(), "typescript").await.unwrap();
    assert_eq!(st.status, LspStatus::Error);
    assert_eq!(
        st.failure.map(|f| f.kind),
        Some(LspFailureKind::IncompatibleDependency)
    );
    assert!(
        !bin.path().join("typescript-language-server.log").exists(),
        "the probe short-circuits every spawn"
    );

    // Unknown language → 422.
    let err = routes.restart(ws, "klingon").await.unwrap_err();
    assert!(matches!(err, LspRouteError::Unsupported(_)));

    std::env::set_var("PATH", orig_path);
}
