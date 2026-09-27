//! Integration tests for `OobeRoutes` (Phase 2 of the `oobe-onboarding` plan):
//! first-run defaults, step-1 confirmation, detect-and-bundle, and completion.
//!
//! OOBE never infers "already onboarded" from pre-existing projects/modes — a
//! fresh `oobe.json` always starts at step 1, not completed, regardless of
//! what the daemon already has. Pre-existing modes simply show up naturally
//! in step 2's list / `detect-and-bundle`'s already-satisfied entries.

use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_routes::modes::ModeRoutes;
use vst_routes::oobe::OobeRouteError;
use vst_routes::oobe::OobeRoutes;
use vst_routes::settings::SettingsRoutes;
use vst_store::StoreHandle;
use vst_types::domain::ProjectRecord;
use vst_types::events::Broadcaster;
use vst_types::rest::shared::Mode;
use vst_types::CliId;

fn build_mode_routes(
    store: &StoreHandle,
    broadcaster: &Broadcaster,
    modes_file: std::path::PathBuf,
    paths: &Paths,
) -> ModeRoutes {
    ModeRoutes::new(store.clone(), broadcaster.clone())
        .with_modes_file(modes_file)
        .with_paths(paths.clone())
}

/// A minimal project record — just enough for `get_all_projects()` to be
/// non-empty.
fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.to_string(),
        absolute_path: format!("/tmp/{id}"),
        prefix: "pr".to_string(),
        is_git: false,
        default_branch: None,
        created_at: "t".to_string(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(0),
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// Seed a single mode (cli: Claude, named like claude's real starter-bundle
/// entry) into `modes_file`.
fn seed_one_claude_mode(modes_file: &std::path::Path) {
    let mode = Mode {
        id: "mode-1".to_string(),
        name: "sonnet-implementer".to_string(),
        cli: CliId::Claude,
        context: "c".to_string(),
        created_at: "t".to_string(),
        model: Some("sonnet".to_string()),
        icon: None,
    };
    std::fs::write(modes_file, serde_json::to_string(&vec![mode]).unwrap()).unwrap();
}

#[tokio::test]
async fn test_get_state_empty_fresh() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    let state = oobe.get_state().await;
    assert!(!state.completed);
    assert_eq!(state.current_step, 1);
}

#[tokio::test]
async fn test_get_state_ignores_preexisting_project_and_mode() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let modes_file = dir.path().join("modes.json");
    let mode_routes = build_mode_routes(&store, &broadcaster, modes_file.clone(), &paths);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    // A daemon that already has a project AND a mode (e.g. seeded demo data,
    // or an upgrade from a pre-OOBE version) — OOBE still starts fresh.
    store.add_project(project("p1")).await.unwrap();
    seed_one_claude_mode(&modes_file);

    let state = oobe.get_state().await;
    assert!(!state.completed);
    assert_eq!(state.current_step, 1);
}

#[tokio::test]
async fn test_get_state_ignores_preexisting_project_alone() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    store.add_project(project("p1")).await.unwrap();

    // A pre-existing project alone does NOT advance step1_confirmed — only an
    // explicit confirm_step1() call does.
    let state = oobe.get_state().await;
    assert!(!state.completed);
    assert_eq!(state.current_step, 1);
}

#[tokio::test]
async fn test_detect_and_bundle_fills_gaps_in_a_preexisting_partial_bundle() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let modes_file = dir.path().join("modes.json");

    // Seed exactly one of claude's 3 named bundle modes, no project yet.
    seed_one_claude_mode(&modes_file);

    // Build ModeRoutes whose binary_checker only reads claude as detected, so
    // cursor/opencode/agy do NOT spawn their own fallback modes.
    let mode_routes = build_mode_routes(&store, &broadcaster, modes_file, &paths)
        .with_binary_checker(|b| b == "claude");
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes, settings_routes, broadcaster.clone(), paths.clone());

    let result = oobe.detect_and_bundle().await;
    // The pre-existing "sonnet-implementer" is left alone (not re-created);
    // the 2 missing named entries are filled in — no marker suppresses this,
    // since OOBE never seeds `auto_bundle_created_for` from pre-existing state.
    let created_names: Vec<&str> = result.created.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(created_names.len(), 2, "expected 2 filled-in modes, got {created_names:?}");
    assert!(created_names.contains(&"opus-planner"));
    assert!(created_names.contains(&"fable-security-reviewer"));
    assert!(!created_names.contains(&"sonnet-implementer"));
}

#[tokio::test]
async fn test_confirm_step1_validation_then_success() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    // Relative path -> 400 ValidationError.
    let rel = oobe.confirm_step1("relative/path".to_string()).await;
    assert!(matches!(rel, Err(OobeRouteError::ValidationError(_))));

    // Absolute path under the temp dir -> 200 + step 2.
    let abs = dir.path().join("projects").to_string_lossy().to_string();
    let ok = oobe
        .confirm_step1(abs.clone())
        .await
        .expect("absolute path should succeed");
    assert!(ok.ok);
    assert_eq!(ok.default_projects_dir, abs);

    let state = oobe.get_state().await;
    assert_eq!(state.current_step, 2);
}

#[tokio::test]
async fn test_step1_confirmation_survives_a_fresh_instance() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);

    // Instance A — confirm step 1 against a fresh OOBE, then drop it.
    {
        let mode_routes =
            build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
        let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
        let oobe_a = OobeRoutes::new(mode_routes, settings_routes, broadcaster.clone(), paths.clone());

        let abs = dir.path().join("projects").to_string_lossy().to_string();
        oobe_a
            .confirm_step1(abs.clone())
            .await
            .expect("absolute path should succeed");

        let state = oobe_a.get_state().await;
        assert_eq!(state.current_step, 2);
    } // instance A dropped

    // Instance B — a brand-new construction pointed at the SAME oobe.json
    // (same `Paths`/temp dir), simulating a fresh process / daemon restart.
    // Nothing in-memory may be required for the step-1 confirmation to survive.
    let mode_routes_b =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
    let settings_routes_b = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe_b = OobeRoutes::new(mode_routes_b, settings_routes_b, broadcaster.clone(), paths.clone());

    let state = oobe_b.get_state().await;
    assert!(!state.completed);
    assert_eq!(state.current_step, 2);
}

#[tokio::test]
async fn test_complete_requires_mode_for_detected_cli() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths)
            .with_binary_checker(|_| true);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    // Zero modes -> 409 NoModeForDetectedCli.
    let err = oobe.complete().await.unwrap_err();
    assert!(matches!(err, OobeRouteError::NoModeForDetectedCli));

    // Seed a mode via ensure_starter_bundle (all CLIs detected), then complete.
    mode_routes.ensure_starter_bundle(CliId::Claude).await;
    let ok = oobe
        .complete()
        .await
        .expect("complete should succeed after seeding a mode");
    assert!(ok.ok);
    assert!(ok.completed);

    let state = oobe.get_state().await;
    assert!(state.completed);
}

#[tokio::test]
async fn test_complete_during_detect_and_bundle_is_not_undone() {
    // Regression: detect_and_bundle used to read oobe.json once, do slow
    // (network-bound) bundle work, then write back that STALE snapshot
    // wholesale — silently clobbering a `complete()` that landed in between.
    // It must now only merge its own marker additions into a freshly-read
    // state under the lock.
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes = build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths)
        .with_binary_checker(|b| b == "claude");
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes.clone(), settings_routes, broadcaster.clone(), paths.clone());

    // Seed a mode directly (bypassing detect_and_bundle) so complete() can
    // succeed, then call complete() — simulating it landing on oobe.json
    // "during" some other in-flight detect_and_bundle call.
    mode_routes.ensure_starter_bundle(CliId::Claude).await;
    oobe.complete().await.expect("complete should succeed");
    assert!(oobe.get_state().await.completed);

    // Now call detect_and_bundle (as if it had been in flight this whole
    // time, reading its stale snapshot before `complete()` ran) — it must
    // NOT flip `completed` back to false.
    let _ = oobe.detect_and_bundle().await;
    assert!(
        oobe.get_state().await.completed,
        "detect_and_bundle must not undo a concurrent complete()"
    );
}

#[tokio::test]
async fn test_confirm_step1_rejects_an_existing_unwritable_directory() {
    let dir = tempdir().unwrap();
    let paths = Paths::with_home(dir.path().join("vst"));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let mode_routes =
        build_mode_routes(&store, &broadcaster, dir.path().join("modes.json"), &paths);
    let settings_routes = SettingsRoutes::new(paths.clone(), broadcaster.clone());
    let oobe = OobeRoutes::new(mode_routes, settings_routes, broadcaster.clone(), paths.clone());

    // A directory that already EXISTS but is read-only — create_dir_all alone
    // would report success here since it's a no-op on an existing dir; the
    // writability probe must catch it instead.
    let readonly_dir = dir.path().join("readonly");
    std::fs::create_dir_all(&readonly_dir).unwrap();
    let mut perms = std::fs::metadata(&readonly_dir).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&readonly_dir, perms.clone()).unwrap();

    let result = oobe
        .confirm_step1(readonly_dir.to_string_lossy().to_string())
        .await;

    // Restore write permission so the tempdir can clean itself up.
    perms.set_readonly(false);
    std::fs::set_permissions(&readonly_dir, perms).unwrap();

    assert!(
        matches!(result, Err(OobeRouteError::ValidationError(_))),
        "expected a validation error for an unwritable existing directory, got {result:?}"
    );
}
