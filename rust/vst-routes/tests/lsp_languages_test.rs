//! Integration test for the host-wide LSP language survey endpoint.
//!
//! Verifies that `LspRoutes::language_survey()` returns exactly the 16
//! registered languages, and that each entry serializes with the exact
//! camelCase key set the frontend depends on. It deliberately does NOT assert
//! a specific `installedOnHost` value for any language — the test runner's
//! installed toolchain varies.

use std::sync::Arc;

use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_lsp::LspManager;
use vst_routes::lsp::LspRoutes;
use vst_store::StoreHandle;

fn build_routes() -> LspRoutes {
    let home_dir = tempdir().unwrap();
    let paths = Paths::with_home(home_dir.path().to_path_buf());
    let store = StoreHandle::open(home_dir.path().join("vibe-station.db")).unwrap();
    let lsp_manager: Arc<LspManager> = LspManager::new(paths.vst_home().clone());
    LspRoutes::new(store, paths, lsp_manager)
}

#[tokio::test]
async fn test_language_survey_returns_16_camelcase_entries() {
    let routes = build_routes();
    let response = routes.language_survey();

    assert_eq!(response.languages.len(), 16);

    for entry in &response.languages {
        let value = serde_json::to_value(entry).expect("entry must serialize");
        let obj = value.as_object().expect("entry must serialize to an object");
        let keys: std::collections::BTreeSet<&str> = obj.keys().map(|k| k.as_str()).collect();
        let expected: std::collections::BTreeSet<&str> = [
            "language",
            "displayName",
            "command",
            "installedOnHost",
            "installCommand",
            "installNote",
        ]
        .iter()
        .copied()
        .collect();
        assert_eq!(
            keys, expected,
            "entry for language {} has unexpected keys",
            entry.language
        );
    }
}
