//! HTTP-level tests for `POST /api/modes/:cli/starter-bundle`.
//!
//! Asserts that every supported CLI can create starter modes via the REST API,
//! and that invalid CLIs are rejected with 400 Bad Request.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_agents::registry::SUPPORTED_CLIS;
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::oobe::StarterBundleResult;
use vst_types::CliId;

fn make_opts(tmp: &std::path::Path) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster,
        json_registry,
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths,
    }
}

#[tokio::test]
async fn test_starter_bundle_http_supported_for_all_clis() {
    let tmp = tempdir().unwrap();
    let _home_guard = with_home(tmp.path().to_path_buf());
    let router = build_app(make_opts(tmp.path()));

    for &cli in &SUPPORTED_CLIS {
        let uri = format!("/api/modes/{}/starter-bundle", cli.as_str());

        // First call: starter modes should be created
        let req = Request::builder()
            .uri(&uri)
            .method("POST")
            .body(Body::empty())
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "Starter bundle creation failed for CLI {}",
            cli.as_str()
        );

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let result: StarterBundleResult = serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            panic!(
                "Failed to deserialize StarterBundleResult for CLI {}: {}\nBody: {}",
                cli.as_str(),
                e,
                String::from_utf8_lossy(&bytes)
            )
        });

        // Specifically check that pi and codex succeed with created default modes
        if cli == CliId::Pi || cli == CliId::Codex {
            assert!(
                result.models_error.is_none(),
                "CLI {} had models_error: {:?}",
                cli.as_str(),
                result.models_error
            );
            assert_eq!(
                result.created.len(),
                1,
                "Expected 1 mode created for CLI {}",
                cli.as_str()
            );
            assert_eq!(result.created[0].name, format!("{}-default", cli.as_str()));
            assert_eq!(result.created[0].cli, cli);
            assert_eq!(result.created[0].icon.as_deref(), Some(cli.as_str()));
        }

        // Second call: idempotent, already complete
        let req2 = Request::builder()
            .uri(&uri)
            .method("POST")
            .body(Body::empty())
            .unwrap();

        let resp2 = router.clone().oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);

        let bytes2 = axum::body::to_bytes(resp2.into_body(), usize::MAX)
            .await
            .unwrap();
        let result2: StarterBundleResult = serde_json::from_slice(&bytes2).unwrap();

        if cli == CliId::Pi || cli == CliId::Codex {
            assert!(result2.created.is_empty());
            assert!(result2.already_complete);
            assert!(result2
                .already_present
                .iter()
                .any(|m| m.name == format!("{}-default", cli.as_str())));
        }
    }
}

#[tokio::test]
async fn test_starter_bundle_http_rejects_unknown_cli() {
    let tmp = tempdir().unwrap();
    let _home_guard = with_home(tmp.path().to_path_buf());
    let router = build_app(make_opts(tmp.path()));

    let req = Request::builder()
        .uri("/api/modes/unknown_cli_xyz/starter-bundle")
        .method("POST")
        .body(Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(val, serde_json::json!({ "error": "unknown_cli" }));
}
