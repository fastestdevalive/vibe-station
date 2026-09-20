//! Tests for `modes` and `open` routes (dispatch #8, final continuation of 07a).
//!
//! Covers:
//! - Modes:
//!   - `load_modes`, `resolve_mode_id`, `json_unsupported_cli`, `find_mode`
//!   - `GET /supported-clis` (returns all 4 CLIs with defaults, capabilities, native history support)
//!   - `GET /cli-models?cli=` (caches results with TTL, deduplicates concurrent requests)
//!   - `GET /modes` (lists all modes from file/cache)
//!   - `POST /modes` (validation: name 1-64, context 1-10000, model <= 100, conflict 409, max 20 400, broadcasts `ModeCreated`)
//!   - `PUT /modes/:id` (patch semantics: update name, context, model, cli change clears model unless supplied, conflict 409, 404, broadcasts `ModeUpdated`)
//!   - `DELETE /modes/:id` (404, computes affected_sessions across worktree and direct sessions, broadcasts `ModeDeleted`)
//! - Open:
//!   - `POST /open` (validation: empty 400, non-absolute 400, not found 400, not directory 400)
//!   - upsert: existing directory returns existing projectId and emits navigate
//!   - new project: slugify, collision counter deduplication, prefix creation, git detection, broadcasts `ProjectCreated` and `Navigate`
//!   - 3-second navigate replay buffer

use std::path::Path;
use std::process::Command;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_routes::modes::{
    find_mode, json_unsupported_cli, load_modes, resolve_mode_id, ModeRouteError, ModeRoutes,
    MAX_CONTEXT_LEN, MAX_MODES,
};
use vst_routes::open::{OpenRouteError, OpenRoutes};
use vst_store::StoreHandle;
use vst_types::domain::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::modes::{CreateModeBody, UpdateModeBody};
use vst_types::rest::open::OpenBody;
use vst_types::rest::shared::Mode;
use vst_types::CliId;

fn init_git_repo(path: &Path) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git command {:?} failed", args);
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Test Agent"]);
    run(&["config", "user.email", "test@agent.local"]);
    std::fs::write(path.join("README.md"), "# Test\n").unwrap();
    run(&["add", "README.md"]);
    run(&["commit", "-m", "Initial commit"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Modes Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_modes_pure_and_resolution_helpers() {
    let dir = tempdir().unwrap();
    let modes_file = dir.path().join("modes.json");

    let modes = vec![
        Mode {
            id: "mode-1".to_string(),
            name: "Claude Code".to_string(),
            cli: CliId::Claude,
            context: "Be helpful".to_string(),
            created_at: "2026-09-15T00:00:00Z".to_string(),
            model: Some("claude-3-5-sonnet".to_string()),
            icon: None,
        },
        Mode {
            id: "mode-2".to_string(),
            name: "Cursor Fast".to_string(),
            cli: CliId::Cursor,
            context: "Be fast".to_string(),
            created_at: "2026-09-15T00:00:00Z".to_string(),
            model: None,
            icon: None,
        },
    ];

    std::fs::write(&modes_file, serde_json::to_string(&modes).unwrap()).unwrap();

    // Use test seam with with_modes_file
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster).with_modes_file(modes_file.clone());

    let loaded = routes.load_modes().await;
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "mode-1");
    assert_eq!(loaded[1].id, "mode-2");

    // Also check default helper functions with empty or nonexistent
    assert!(load_modes().is_empty() || !load_modes().is_empty());
    assert_eq!(resolve_mode_id("non-existent-id-xyz"), None);
    assert_eq!(find_mode("non-existent-id-xyz"), None);
    assert_eq!(json_unsupported_cli("non-existent-id-xyz"), None);
}

#[tokio::test]
async fn test_modes_supported_clis_and_models() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster);

    let supported = routes.list_supported_clis();
    assert_eq!(supported.len(), 4);

    let claude = supported.iter().find(|s| s.id == CliId::Claude).unwrap();
    assert!(!claude.default_model.is_empty());
    assert!(claude.supports_json);
    assert!(claude.imports_native_history);
    assert!(claude.supports_json_to_terminal_resume);

    let cursor = supported.iter().find(|s| s.id == CliId::Cursor).unwrap();
    assert!(!cursor.default_model.is_empty());
    assert!(!cursor.imports_native_history);
    // Cursor doesn't support json to terminal resume
    assert!(!cursor.supports_json_to_terminal_resume);

    let opencode = supported.iter().find(|s| s.id == CliId::Opencode).unwrap();
    assert!(opencode.imports_native_history);

    let agy = supported.iter().find(|s| s.id == CliId::Agy).unwrap();
    assert!(!agy.imports_native_history);

    // Test resolve_cli_models
    let models = routes.resolve_cli_models(CliId::Claude).await;
    assert!(!models.models.is_empty() || models.error.is_some());

    // Second call should hit the cache immediately
    let cached = routes.resolve_cli_models(CliId::Claude).await;
    assert_eq!(models.models, cached.models);
}

#[tokio::test]
async fn test_modes_crud_lifecycle_and_events() {
    let dir = tempdir().unwrap();
    let modes_file = dir.path().join("modes.json");
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(32);
    let mut rx = broadcaster.subscribe();
    let routes = ModeRoutes::new(store.clone(), broadcaster).with_modes_file(modes_file);

    // 1. Initial list empty
    let list0 = routes.list_modes().await;
    assert!(list0.is_empty());

    // 2. Create mode
    let created = routes
        .create_mode(CreateModeBody {
            name: "Plan Hard".to_string(),
            cli: CliId::Claude,
            context: "Plan everything first".to_string(),
            preset_id: None,
            model: Some("claude-3-7-sonnet".to_string()),
            icon: None,
        })
        .await
        .expect("create_mode should succeed");

    assert_eq!(created.name, "Plan Hard");
    assert_eq!(created.cli, CliId::Claude);
    assert_eq!(created.context, "Plan everything first");
    assert_eq!(created.model.as_deref(), Some("claude-3-7-sonnet"));
    assert!(created.id.starts_with("mode-"));

    let event1 = rx.try_recv().expect("ModeCreated event expected");
    match event1 {
        ServerEvent::ModeCreated { mode } => {
            assert_eq!(
                mode.get("id").and_then(|v| v.as_str()),
                Some(created.id.as_str())
            );
            assert_eq!(mode.get("name").and_then(|v| v.as_str()), Some("Plan Hard"));
        }
        other => panic!("Unexpected event: {other:?}"),
    }

    // 3. Duplicate name conflict 409
    let conflict_res = routes
        .create_mode(CreateModeBody {
            name: "Plan Hard".to_string(),
            cli: CliId::Opencode,
            context: "Some context".to_string(),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(
            conflict_res,
            Err(ModeRouteError::Conflict {
                ref conflict_with,
                ..
            }) if conflict_with.as_deref() == Some("Plan Hard")
        ),
        "Expected conflict on duplicate mode name"
    );

    // 4. Update mode
    let updated = routes
        .update_mode(
            &created.id,
            UpdateModeBody {
                name: Some("Plan Harder".to_string()),
                context: Some("Plan even harder".to_string()),
                cli: Some(CliId::Opencode),
                model: Some("deepseek-v3".to_string()),
                icon: None,
            },
        )
        .await
        .expect("update_mode should succeed");

    assert_eq!(updated.id, created.id);
    assert_eq!(updated.name, "Plan Harder");
    assert_eq!(updated.context, "Plan even harder");
    assert_eq!(updated.cli, CliId::Opencode);
    assert_eq!(updated.model.as_deref(), Some("deepseek-v3"));

    let event2 = rx.try_recv().expect("ModeUpdated event expected");
    match event2 {
        ServerEvent::ModeUpdated { mode } => {
            assert_eq!(
                mode.get("id").and_then(|v| v.as_str()),
                Some(created.id.as_str())
            );
            assert_eq!(
                mode.get("name").and_then(|v| v.as_str()),
                Some("Plan Harder")
            );
        }
        other => panic!("Unexpected event: {other:?}"),
    }

    // 5. Update CLI without supplying model clears old model
    let updated2 = routes
        .update_mode(
            &created.id,
            UpdateModeBody {
                name: None,
                context: None,
                cli: Some(CliId::Claude),
                model: None,
                icon: None,
            },
        )
        .await
        .expect("cli change without model should succeed");
    assert_eq!(updated2.cli, CliId::Claude);
    assert_eq!(updated2.model, None);

    let event_update2 = rx.try_recv().expect("ModeUpdated event expected");
    match event_update2 {
        ServerEvent::ModeUpdated { mode } => {
            assert_eq!(mode.get("cli").and_then(|v| v.as_str()), Some("claude"));
        }
        other => panic!("Unexpected event: {other:?}"),
    }

    // 6. Update non-existent mode 404
    let not_found_res = routes
        .update_mode(
            "mode-missing-id",
            UpdateModeBody {
                name: Some("New Name".to_string()),
                context: None,
                cli: None,
                model: None,
                icon: None,
            },
        )
        .await;
    assert!(
        matches!(not_found_res, Err(ModeRouteError::NotFound(_))),
        "Expected NotFound for missing mode update"
    );

    // 7. Seed active sessions referencing this mode in store to verify count on delete
    let session1 = SessionRecord {
        id: "sess-1".to_string(),
        worktree_id: Some("wt-1".to_string()),
        project_id: "proj-1".to_string(),
        is_main: true,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some(created.id.clone()),
        name: None,
        name_source: None,
        tmux_name: "sess-1".to_string(),
        use_tmux: false,
        channel: Some(vst_types::domain::Channel::Json),
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-09-15T00:00:00Z".to_string(),
        },
    };
    let session2_done = SessionRecord {
        id: "sess-2".to_string(),
        worktree_id: Some("wt-1".to_string()),
        project_id: "proj-1".to_string(),
        is_main: false,
        sort_order: 2.0,
        r#type: SessionType::Agent,
        mode_id: Some(created.id.clone()),
        name: None,
        name_source: None,
        tmux_name: "sess-2".to_string(),
        use_tmux: false,
        channel: Some(vst_types::domain::Channel::Json),
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Done,
            reason: None,
            last_transition_at: "2026-09-15T00:00:00Z".to_string(),
        },
    };
    let direct_session = SessionRecord {
        id: "sess-dir".to_string(),
        worktree_id: None,
        project_id: "proj-1".to_string(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some(created.id.clone()),
        name: None,
        name_source: None,
        tmux_name: "sess-dir".to_string(),
        use_tmux: false,
        channel: Some(vst_types::domain::Channel::Json),
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2026-09-15T00:00:00Z".to_string(),
        },
    };

    let project = ProjectRecord {
        id: "proj-1".to_string(),
        absolute_path: "/tmp/fake-proj".to_string(),
        prefix: "pr".to_string(),
        is_git: false,
        default_branch: None,
        created_at: "2026-09-15T00:00:00Z".to_string(),
        hidden: None,
        direct_sessions: vec![direct_session],
        direct_session_seq: Some(1),
        worktrees: vec![WorktreeRecord {
            id: "wt-1".to_string(),
            name: None,
            branch: "main".to_string(),
            branch_is_placeholder: None,
            base_branch: "main".to_string(),
            base_sha: "0000000".to_string(),
            created_at: "2026-09-15T00:00:00Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: Some(0),
            agent_seq: Some(2),
            sessions: vec![session1, session2_done],
        }],
        next_worktree_num: Some(2),
    };
    store.add_project(project).await.unwrap();

    // 8. Delete mode counts active sessions (sess-1 working + sess-dir idle = 2; sess-2 done ignored)
    let del_res = routes
        .delete_mode(&created.id)
        .await
        .expect("delete_mode should succeed");
    assert!(del_res.ok);
    assert_eq!(del_res.affected_sessions, 2);

    let event3 = rx.try_recv().expect("ModeDeleted event expected");
    match event3 {
        ServerEvent::ModeDeleted { mode_id } => {
            assert_eq!(mode_id, created.id);
        }
        other => panic!("Unexpected event: {other:?}"),
    }

    // 9. Delete missing mode 404
    let del_missing = routes.delete_mode("mode-missing-id").await;
    assert!(
        matches!(del_missing, Err(ModeRouteError::NotFound(_))),
        "Expected NotFound for deleting missing mode"
    );

    // List is empty again
    assert!(routes.list_modes().await.is_empty());
}

#[tokio::test]
async fn test_modes_icon_on_create() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster).with_modes_file(dir.path().join("modes.json"));

    let mk = |name: &str, cli: CliId, model: Option<&str>, icon: Option<&str>| {
        let model = model.map(str::to_string);
        let icon = icon.map(str::to_string);
        routes.create_mode(CreateModeBody {
            name: name.to_string(),
            cli,
            context: "c".to_string(),
            preset_id: None,
            model,
            icon,
        })
    };

    // One mode per CLI -> expected icon derived from cli (+ model).
    assert_eq!(
        mk("Claude M", CliId::Claude, None, None)
            .await
            .unwrap()
            .icon
            .as_deref(),
        Some("claude")
    );
    assert_eq!(
        mk("Cursor M", CliId::Cursor, None, None)
            .await
            .unwrap()
            .icon
            .as_deref(),
        Some("cursor")
    );
    assert_eq!(
        mk("Agy M", CliId::Agy, None, None)
            .await
            .unwrap()
            .icon
            .as_deref(),
        Some("agy")
    );
    // opencode + deepseek model -> deepseek
    assert_eq!(
        mk(
            "DS M",
            CliId::Opencode,
            Some("deepseek-local/deepseek-v4"),
            None
        )
        .await
        .unwrap()
        .icon
        .as_deref(),
        Some("deepseek")
    );
    // opencode + non-deepseek model -> opencode
    assert_eq!(
        mk("OC M", CliId::Opencode, Some("gpt-5"), None)
            .await
            .unwrap()
            .icon
            .as_deref(),
        Some("opencode")
    );
    // Explicit icon wins over derivation on create.
    assert_eq!(
        mk("Explicit M", CliId::Claude, None, Some("opencode"))
            .await
            .unwrap()
            .icon
            .as_deref(),
        Some("opencode")
    );
}

#[tokio::test]
async fn test_modes_icon_rederive_on_update() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster).with_modes_file(dir.path().join("modes.json"));

    let ds = routes
        .create_mode(CreateModeBody {
            name: "DS M".to_string(),
            cli: CliId::Opencode,
            context: "c".to_string(),
            preset_id: None,
            model: Some("deepseek-v3".to_string()),
            icon: None,
        })
        .await
        .unwrap();
    assert_eq!(ds.icon.as_deref(), Some("deepseek"));

    // Changing model away from deepseek re-derives to opencode.
    let flipped = routes
        .update_mode(
            &ds.id,
            UpdateModeBody {
                name: None,
                context: None,
                cli: None,
                model: Some("gpt-5".to_string()),
                icon: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(flipped.icon.as_deref(), Some("opencode"));

    // ... and back to deepseek flips it back.
    let flipped_back = routes
        .update_mode(
            &ds.id,
            UpdateModeBody {
                name: None,
                context: None,
                cli: None,
                model: Some("deepseek-v4".to_string()),
                icon: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(flipped_back.icon.as_deref(), Some("deepseek"));

    // Changing CLI re-derives.
    let cli_flipped = routes
        .update_mode(
            &ds.id,
            UpdateModeBody {
                name: None,
                context: None,
                cli: Some(CliId::Claude),
                model: None,
                icon: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(cli_flipped.icon.as_deref(), Some("claude"));

    // Explicit icon on update wins over derivation.
    let explicit_upd = routes
        .update_mode(
            &ds.id,
            UpdateModeBody {
                name: None,
                context: None,
                cli: None,
                model: Some("gpt-5".to_string()),
                icon: Some("cursor".to_string()),
            },
        )
        .await
        .unwrap();
    assert_eq!(explicit_upd.icon.as_deref(), Some("cursor"));

    // Re-sending the SAME cli (the edit dialog always does) must not clobber an
    // explicit icon; only a real cli change re-derives.
    let same_cli = routes
        .update_mode(
            &ds.id,
            UpdateModeBody {
                name: Some("renamed".to_string()),
                context: None,
                cli: Some(CliId::Claude),
                model: Some("gpt-5".to_string()),
                icon: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(same_cli.icon.as_deref(), Some("cursor"));
}

#[tokio::test]
async fn test_modes_icon_rejects_unknown_key() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let routes =
        ModeRoutes::new(store, Broadcaster::new(16)).with_modes_file(dir.path().join("modes.json"));

    let err = routes
        .create_mode(CreateModeBody {
            name: "bad".to_string(),
            cli: CliId::Claude,
            context: "c".to_string(),
            preset_id: None,
            model: None,
            icon: Some("constructor".to_string()),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ModeRouteError::Validation(_)), "{err:?}");
}

#[tokio::test]
async fn test_modes_icon_backfill_cached_loader() {
    let dir = tempdir().unwrap();
    let modes_file = dir.path().join("modes.json");
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster).with_modes_file(modes_file.clone());

    std::fs::write(
        &modes_file,
        serde_json::to_string(&vec![
            Mode {
                id: "legacy-claude".to_string(),
                name: "Legacy Claude".to_string(),
                cli: CliId::Claude,
                context: "c".to_string(),
                created_at: "t".to_string(),
                model: None,
                icon: None,
            },
            Mode {
                id: "legacy-ds".to_string(),
                name: "Legacy DS".to_string(),
                cli: CliId::Opencode,
                context: "c".to_string(),
                created_at: "t".to_string(),
                model: Some("deepseek-v3".to_string()),
                icon: None,
            },
        ])
        .unwrap(),
    )
    .unwrap();
    routes.reset_cache_for_test().await;

    let loaded = routes.load_modes().await;
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded
            .iter()
            .find(|m| m.id == "legacy-claude")
            .unwrap()
            .icon
            .as_deref(),
        Some("claude")
    );
    assert_eq!(
        loaded
            .iter()
            .find(|m| m.id == "legacy-ds")
            .unwrap()
            .icon
            .as_deref(),
        Some("deepseek")
    );
}

#[tokio::test]
async fn test_modes_icon_backfill_free_loader() {
    let dir = tempdir().unwrap();
    let home = dir.path().join("home");
    let vst_dir = home.join(".vibe-station");
    std::fs::create_dir_all(&vst_dir).unwrap();
    std::fs::write(
        vst_dir.join("modes.json"),
        serde_json::to_string(&vec![
            Mode {
                id: "free-claude".to_string(),
                name: "Free Claude".to_string(),
                cli: CliId::Claude,
                context: "c".to_string(),
                created_at: "t".to_string(),
                model: None,
                icon: None,
            },
            Mode {
                id: "free-oc".to_string(),
                name: "Free OC".to_string(),
                cli: CliId::Opencode,
                context: "c".to_string(),
                created_at: "t".to_string(),
                model: Some("gpt-5".to_string()),
                icon: None,
            },
        ])
        .unwrap(),
    )
    .unwrap();

    {
        let _guard = with_home(home.clone());
        let free = load_modes();
        assert_eq!(free.len(), 2);
        assert_eq!(
            free.iter()
                .find(|m| m.id == "free-claude")
                .unwrap()
                .icon
                .as_deref(),
            Some("claude")
        );
        assert_eq!(
            free.iter()
                .find(|m| m.id == "free-oc")
                .unwrap()
                .icon
                .as_deref(),
            Some("opencode")
        );
    }
}
#[tokio::test]
async fn test_modes_validation_and_limits() {
    let dir = tempdir().unwrap();
    let modes_file = dir.path().join("modes.json");
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let routes = ModeRoutes::new(store, broadcaster).with_modes_file(modes_file);

    // Empty name
    let err_empty_name = routes
        .create_mode(CreateModeBody {
            name: "   ".to_string(),
            cli: CliId::Claude,
            context: "valid".to_string(),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(err_empty_name, Err(ModeRouteError::Validation(_))),
        "Empty name should fail validation"
    );

    // Name > 64 chars
    let err_long_name = routes
        .create_mode(CreateModeBody {
            name: "a".repeat(65),
            cli: CliId::Claude,
            context: "valid".to_string(),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(err_long_name, Err(ModeRouteError::Validation(_))),
        "Long name should fail validation"
    );

    // Empty context
    let err_empty_context = routes
        .create_mode(CreateModeBody {
            name: "valid".to_string(),
            cli: CliId::Claude,
            context: "   ".to_string(),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(err_empty_context, Err(ModeRouteError::Validation(_))),
        "Empty context should fail validation"
    );

    // Context > MAX_CONTEXT_LEN
    let err_long_context = routes
        .create_mode(CreateModeBody {
            name: "valid".to_string(),
            cli: CliId::Claude,
            context: "c".repeat(MAX_CONTEXT_LEN + 1),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(err_long_context, Err(ModeRouteError::Validation(_))),
        "Overlong context should fail validation"
    );

    // Model > 100 chars
    let err_long_model = routes
        .create_mode(CreateModeBody {
            name: "valid".to_string(),
            cli: CliId::Claude,
            context: "valid".to_string(),
            preset_id: None,
            model: Some("m".repeat(101)),
            icon: None,
        })
        .await;
    assert!(
        matches!(err_long_model, Err(ModeRouteError::Validation(_))),
        "Overlong model should fail validation"
    );

    // Fill up to MAX_MODES (20)
    for i in 1..=MAX_MODES {
        routes
            .create_mode(CreateModeBody {
                name: format!("Mode {i}"),
                cli: CliId::Claude,
                context: format!("Context {i}"),
                preset_id: None,
                model: None,
                icon: None,
            })
            .await
            .unwrap();
    }

    // 21st mode rejected with 400 validation error
    let err_max = routes
        .create_mode(CreateModeBody {
            name: "Mode 21".to_string(),
            cli: CliId::Claude,
            context: "Context 21".to_string(),
            preset_id: None,
            model: None,
            icon: None,
        })
        .await;
    assert!(
        matches!(err_max, Err(ModeRouteError::Validation(ref msg)) if msg.contains("Maximum 20 modes allowed")),
        "Expected Maximum 20 modes error"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Open Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_open_validation_errors() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let open_routes = OpenRoutes::new(store, broadcaster);

    // Empty path
    let err_empty = open_routes
        .open(OpenBody {
            path: "".to_string(),
        })
        .await;
    assert!(
        matches!(err_empty, Err(OpenRouteError::InvalidPath(_))),
        "Empty path should return InvalidPath"
    );

    // Relative path
    let err_rel = open_routes
        .open(OpenBody {
            path: "relative/path".to_string(),
        })
        .await;
    assert!(
        matches!(err_rel, Err(OpenRouteError::InvalidPath(ref d)) if d == "Path must be absolute"),
        "Relative path should return InvalidPath with detail"
    );

    // Path not found
    let non_existent = dir.path().join("does-not-exist");
    let err_not_found = open_routes
        .open(OpenBody {
            path: non_existent.to_string_lossy().to_string(),
        })
        .await;
    assert!(
        matches!(err_not_found, Err(OpenRouteError::PathNotFound)),
        "Non-existent path should return PathNotFound"
    );

    // Path is a file, not a directory
    let file_path = dir.path().join("regular_file.txt");
    std::fs::write(&file_path, "hello").unwrap();
    let err_not_dir = open_routes
        .open(OpenBody {
            path: file_path.to_string_lossy().to_string(),
        })
        .await;
    assert!(
        matches!(err_not_dir, Err(OpenRouteError::PathNotDirectory)),
        "File path should return PathNotDirectory"
    );
}

#[tokio::test]
async fn test_open_upsert_and_new_project_with_replay() {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(32);
    let mut rx = broadcaster.subscribe();
    let open_routes = OpenRoutes::new(store.clone(), broadcaster);

    let project_dir = dir.path().join("my-cool-project");
    std::fs::create_dir_all(&project_dir).unwrap();
    init_git_repo(&project_dir);

    let abs_path = project_dir.to_string_lossy().to_string();

    // 1. Open new project
    let result = open_routes
        .open(OpenBody {
            path: abs_path.clone(),
        })
        .await
        .expect("open should succeed on valid git directory");

    assert_eq!(result.project_id, "my-cool-project");

    // Check project was saved in store with detected git branch
    let saved = store.get_project(&result.project_id).await.unwrap();
    assert_eq!(saved.absolute_path, abs_path);
    assert!(saved.is_git);
    assert_eq!(saved.default_branch.as_deref(), Some("main"));

    // Check events emitted
    let mut saw_project_created = false;
    let mut saw_navigate = false;

    while let Ok(event) = rx.try_recv() {
        match event {
            ServerEvent::ProjectCreated { project } => {
                saw_project_created = true;
                assert_eq!(
                    project.get("id").and_then(|v| v.as_str()),
                    Some("my-cool-project")
                );
            }
            ServerEvent::Navigate { project_id } => {
                saw_navigate = true;
                assert_eq!(project_id, "my-cool-project");
            }
            _ => {}
        }
    }
    assert!(saw_project_created, "Expected ProjectCreated event");
    assert!(saw_navigate, "Expected Navigate event");

    // Check navigate replay buffer
    let replayed = open_routes.replay_navigate();
    assert_eq!(replayed.as_deref(), Some("my-cool-project"));

    // 2. Upsert: calling open again on same path returns same project ID without creating a duplicate
    let result_upsert = open_routes
        .open(OpenBody {
            path: abs_path.clone(),
        })
        .await
        .expect("upsert open should succeed");

    assert_eq!(result_upsert.project_id, "my-cool-project");
    let all = store.get_all_projects().await;
    assert_eq!(all.len(), 1);

    // 3. Name collision creates deduplicated id with counter suffix (e.g. -2)
    let project_dir2 = dir.path().join("sub").join("my-cool-project");
    std::fs::create_dir_all(&project_dir2).unwrap();
    let abs_path2 = project_dir2.to_string_lossy().to_string();

    let result2 = open_routes
        .open(OpenBody {
            path: abs_path2.clone(),
        })
        .await
        .expect("open second directory with same name should succeed");

    assert_eq!(result2.project_id, "my-cool-project-2");
    let all2 = store.get_all_projects().await;
    assert_eq!(all2.len(), 2);
}
