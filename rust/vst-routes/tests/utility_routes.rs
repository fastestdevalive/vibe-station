//! Tests for `health`, `ordered_lists`, `settings`, `skills`, `fs`, and `attachments`
//! (07b dispatch #1).
//!
//! Every test contains explicit, assert!()-wrapped checks.
//! No bare `matches!(` calls without `assert!(`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_routes::attachments::{
    pending_upload_ref_path, sanitize_filename, AttachmentRouteError, AttachmentRoutes, UploadPart,
    MAX_FILE_BYTES,
};
use vst_routes::fs::{expand_tilde, FsRouteError, FsRoutes};
use vst_routes::health::HealthRoutes;
use vst_routes::ordered_lists::{OrderedListsRouteError, OrderedListsRoutes};
use vst_routes::settings::{
    default_projects_dir, default_skill_paths, SettingsRouteError, SettingsRoutes,
};
use vst_routes::skills::{parse_skill_frontmatter, scan_skill_directory, SkillsRoutes};
use vst_store::StoreHandle;
use vst_types::domain::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::ordered_lists::{PutOrderedListBody, PINNED_ALL};
use vst_types::rest::settings::{MarkdownStyle, PatchSettingsBody};
use vst_types::ws::ServerMessage;
use vst_ws::state::attachment_registry::AttachmentRegistry;

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
// Health Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_health_route() {
    let started = Instant::now() - Duration::from_secs(42);
    let routes = HealthRoutes::new("1.2.3", 8080, started);
    let res = routes.health();

    assert!(res.ok);
    assert_eq!(res.version, "1.2.3");
    assert_eq!(res.port, 8080);
    assert!(res.uptime >= 42);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordered Lists Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ordered_lists_get_put_validation_and_broadcast() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(32);
    let mut rx = broadcaster.subscribe();

    let routes = OrderedListsRoutes::new(store, broadcaster);

    // GET on invalid scopeKey returns 400
    let err = routes.get_ordered_list("invalid-scope").await.unwrap_err();
    assert_eq!(err.error_code(), "validation_error");
    assert!(matches!(err, OrderedListsRouteError::InvalidScopeKey(k) if k == "invalid-scope"));

    // GET initially empty
    let list = routes.get_ordered_list(PINNED_ALL).await.unwrap();
    assert_eq!(list.scope_key, PINNED_ALL);
    assert!(list.item_ids.is_empty());
    assert!(list.updated_at.is_none());

    // PUT validation: scopeKey must be pinned-all
    let err = routes
        .put_ordered_list(
            "wrong",
            PutOrderedListBody {
                item_ids: vec!["a".into()],
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrderedListsRouteError::InvalidScopeKey(_)));

    // PUT validation: max 500 items
    let too_many = (0..501).map(|i| format!("item-{}", i)).collect();
    let err = routes
        .put_ordered_list(PINNED_ALL, PutOrderedListBody { item_ids: too_many })
        .await
        .unwrap_err();
    assert!(matches!(err, OrderedListsRouteError::ItemIdsTooLong));

    // PUT valid
    let put_res = routes
        .put_ordered_list(
            PINNED_ALL,
            PutOrderedListBody {
                item_ids: vec!["id1".into(), "id2".into()],
            },
        )
        .await
        .unwrap();

    assert!(put_res.ok);
    assert_eq!(put_res.scope_key, PINNED_ALL);
    assert_eq!(put_res.item_ids, vec!["id1", "id2"]);
    assert!(!put_res.updated_at.is_empty());

    // Broadcast was sent
    let ev = rx.try_recv().unwrap();
    assert!(matches!(
        ev,
        ServerEvent::OrderedListUpdated {
            ref scope_key,
            ref item_ids,
            ..
        } if scope_key == PINNED_ALL && item_ids == &["id1", "id2"]
    ));

    // GET reflects update
    let list = routes.get_ordered_list(PINNED_ALL).await.unwrap();
    assert_eq!(list.item_ids, vec!["id1", "id2"]);
    assert!(list.updated_at.is_some());
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_settings_get_patch_and_validation() {
    let tmp = tempdir().unwrap();
    let paths = Paths::with_home(tmp.path().join(".vibe-station"));
    let broadcaster = Broadcaster::new(32);
    let routes = SettingsRoutes::new(paths.clone(), broadcaster);

    // GET with no config file -> defaults
    let s = routes.get_settings().await;
    assert_eq!(s.default_projects_dir, Some(default_projects_dir()));
    assert_eq!(s.skill_paths, Some(default_skill_paths()));
    assert!(!s.home_dir.is_empty());
    // Sticky search-toggle prefs default to false when never set.
    assert_eq!(s.search_case_sensitive, Some(false));
    assert_eq!(s.search_regex, Some(false));
    assert_eq!(s.search_whole_word, Some(false));

    // PATCH validation: relative defaultProjectsDir rejected
    let err = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: Some("relative/path".into()),
            skill_paths: None,
            theme_id: None,
            markdown_style: None,
            reset_markdown_style: None,
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), "validation_error");
    assert!(matches!(
        err,
        SettingsRouteError::DefaultProjectsDirNotAbsolute
    ));

    // PATCH validation: relative skillPaths rejected
    let err = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: None,
            skill_paths: Some(vec!["/valid/abs".into(), "relative/skill".into()]),
            theme_id: None,
            markdown_style: None,
            reset_markdown_style: None,
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), "validation_error");
    assert!(matches!(err, SettingsRouteError::SkillPathsNotAbsolute));

    // Write initial config with transient main fields
    let cfg_path = paths.vst_home().join("config.json");
    tokio::fs::create_dir_all(paths.vst_home()).await.unwrap();
    tokio::fs::write(
        &cfg_path,
        serde_json::json!({
            "pid": 12345,
            "port": 9999,
            "cliToken": "cli-tok",
            "tauriToken": "tauri-tok",
            "browserEpoch": 3,
            "startedAt": "2026-01-01T00:00:00Z"
        })
        .to_string(),
    )
    .await
    .unwrap();

    // PATCH with valid fields and deduplication in skillPaths, plus sticky
    // search-toggle prefs.
    let patch_res = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: Some("/abs/projects".into()),
            skill_paths: Some(vec![
                "/path/one".into(),
                "/path/two".into(),
                "/path/one".into(),
            ]),
            theme_id: None,
            markdown_style: None,
            reset_markdown_style: None,
            search_case_sensitive: Some(true),
            search_regex: Some(true),
            search_whole_word: None,
        })
        .await
        .unwrap();
    assert!(patch_res.ok);

    // Verify GET preserves main fields and applies updates
    let updated = routes.get_settings().await;
    assert_eq!(updated.default_projects_dir, Some("/abs/projects".into()));
    assert_eq!(
        updated.skill_paths,
        Some(vec!["/path/one".into(), "/path/two".into()])
    );
    assert_eq!(updated.pid, Some(12345));
    // Patched fields persist; the untouched one (wholeWord) stays default.
    assert_eq!(updated.search_case_sensitive, Some(true));
    assert_eq!(updated.search_regex, Some(true));
    assert_eq!(updated.search_whole_word, Some(false));
    assert_eq!(updated.port, Some(9999));
    assert_eq!(updated.cli_token, Some("cli-tok".into()));
    assert_eq!(updated.tauri_token, Some("tauri-tok".into()));
    assert_eq!(updated.browser_epoch, Some(3));
    assert_eq!(updated.started_at, Some("2026-01-01T00:00:00Z".into()));
    // theme/markdown not touched by this PATCH -> defaults
    assert_eq!(updated.theme_id, Some("vibestation-dark".into()));
    assert_eq!(updated.markdown_style, None);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(&cfg_path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Theme / Markdown Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_settings_theme_markdown_validation_and_broadcast() {
    let tmp = tempdir().unwrap();
    let paths = Paths::with_home(tmp.path().join(".vibe-station"));
    let broadcaster = Broadcaster::new(32);
    let mut rx = broadcaster.subscribe();
    let routes = SettingsRoutes::new(paths.clone(), broadcaster);

    // PATCH with a bad markdown_style shape (invalid color) -> validation_error
    let err = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: None,
            skill_paths: None,
            theme_id: None,
            markdown_style: Some(MarkdownStyle {
                h1: None,
                h2: None,
                h3: None,
                h4: None,
                h5: None,
                h6: None,
                bold: None,
                italic: None,
                inline_code: None,
                code_block: None,
                code_font_family: None,
                blockquote: None,
                link: Some(vst_types::rest::settings::LinkStyle {
                    color: Some("not-a-color!!".into()),
                }),
            }),
            reset_markdown_style: None,
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), "validation_error");
    assert!(matches!(err, SettingsRouteError::InvalidMarkdownStyle));

    // PATCH valid theme_id + markdown_style -> 200 + GET reflects it
    let style = MarkdownStyle {
        h1: Some(vst_types::rest::settings::HeadingStyle {
            size: Some("2.5em".into()),
            color: Some("#ff0000".into()),
            weight: Some(700),
        }),
        h2: None,
        h3: None,
        h4: None,
        h5: None,
        h6: None,
        bold: Some(vst_types::rest::settings::BoldStyle {
            weight: Some(800),
            color: Some("#00ff00".into()),
        }),
        italic: Some(vst_types::rest::settings::ItalicStyle {
            style: Some("oblique".into()),
            color: Some("blue".into()),
        }),
        inline_code: Some(vst_types::rest::settings::InlineCodeStyle {
            bg: Some("rgb(0,0,0)".into()),
            color: Some("#fff".into()),
        }),
        code_block: Some(vst_types::rest::settings::CodeBlockStyle {
            bg: Some("#111".into()),
            color: Some("#eee".into()),
            border: Some("#333".into()),
        }),
        code_font_family: Some("JetBrains Mono".into()),
        blockquote: Some(vst_types::rest::settings::BlockquoteStyle {
            border: Some("#999".into()),
            color: Some("gray".into()),
        }),
        link: Some(vst_types::rest::settings::LinkStyle {
            color: Some("#0af".into()),
        }),
    };
    let patch_res = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: None,
            skill_paths: None,
            theme_id: Some("dracula".into()),
            markdown_style: Some(style.clone()),
            reset_markdown_style: None,
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap();
    assert!(patch_res.ok);

    let updated = routes.get_settings().await;
    assert_eq!(updated.theme_id, Some("dracula".into()));
    assert_eq!(updated.markdown_style, Some(style.clone()));

    // WS client receives settings:updated with only themeId/markdownStyle, never tokens
    let ev = rx.try_recv().unwrap();
    let msg = vst_ws::broadcaster::server_event_to_message(ev);
    match msg {
        ServerMessage::SettingsThemeUpdated {
            theme_id,
            markdown_style,
        } => {
            assert_eq!(theme_id, Some("dracula".into()));
            assert_eq!(markdown_style, Some(style));
        }
        other => panic!("expected settings:updated, got {:?}", other),
    }

    // resetMarkdownStyle: true clears a previously-set markdown_style
    let reset_res = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: None,
            skill_paths: None,
            theme_id: None,
            markdown_style: None,
            reset_markdown_style: Some(true),
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap();
    assert!(reset_res.ok);

    let cleared = routes.get_settings().await;
    assert_eq!(cleared.theme_id, Some("dracula".into()));
    assert_eq!(cleared.markdown_style, None);

    // reset + same-request markdown_style re-sets it
    let re_set = MarkdownStyle {
        h1: Some(vst_types::rest::settings::HeadingStyle {
            size: Some("3em".into()),
            color: Some("#123456".into()),
            weight: None,
        }),
        h2: None,
        h3: None,
        h4: None,
        h5: None,
        h6: None,
        bold: None,
        italic: None,
        inline_code: None,
        code_block: None,
        code_font_family: None,
        blockquote: None,
        link: None,
    };
    let both_res = routes
        .patch_settings(PatchSettingsBody {
            default_projects_dir: None,
            skill_paths: None,
            theme_id: None,
            markdown_style: Some(re_set.clone()),
            reset_markdown_style: Some(true),
            search_case_sensitive: None,
            search_regex: None,
            search_whole_word: None,
        })
        .await
        .unwrap();
    assert!(both_res.ok);
    let after_both = routes.get_settings().await;
    assert_eq!(after_both.markdown_style, Some(re_set));
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_skills_frontmatter_and_directory_scanning() {
    let valid_fm = "---\nname: my-skill\ndescription: \"Awesome skill\"\nargument-hint: [target]\n---\n# My Skill";
    let parsed = parse_skill_frontmatter(valid_fm).unwrap();
    assert_eq!(parsed.get("name").map(String::as_str), Some("my-skill"));
    assert_eq!(
        parsed.get("description").map(String::as_str),
        Some("Awesome skill")
    );
    assert_eq!(
        parsed.get("argument-hint").map(String::as_str),
        Some("[target]")
    );

    // No frontmatter
    assert!(parse_skill_frontmatter("# No FM").is_none());

    let tmp = tempdir().unwrap();
    let skill_dir = tmp.path().join("skills-dir");
    tokio::fs::create_dir_all(&skill_dir).await.unwrap();

    // Skill 1: valid
    let s1 = skill_dir.join("skill-one");
    tokio::fs::create_dir_all(&s1).await.unwrap();
    tokio::fs::write(
        s1.join("SKILL.md"),
        "---\nname: skill-one\ndescription: First\n---\nBody",
    )
    .await
    .unwrap();

    // Skill 2: missing name -> skipped
    let s2 = skill_dir.join("skill-two");
    tokio::fs::create_dir_all(&s2).await.unwrap();
    tokio::fs::write(s2.join("SKILL.md"), "---\ndescription: No Name\n---\nBody")
        .await
        .unwrap();

    // Skill 3: directory without SKILL.md -> ignored silently
    let s3 = skill_dir.join("not-a-skill");
    tokio::fs::create_dir_all(&s3).await.unwrap();

    let (entries, status) = scan_skill_directory(&skill_dir).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "skill-one");
    assert_eq!(entries[0].description, "First");
    assert_eq!(status.skill_count, 1);
    assert!(status.error.is_some()); // Skipped report

    // Non-existent directory returns missing: true, no 500
    let missing_dir = tmp.path().join("does-not-exist");
    let (m_entries, m_status) = scan_skill_directory(&missing_dir).await;
    assert!(m_entries.is_empty());
    assert_eq!(m_status.missing, Some(true));
    assert!(m_status.error.is_none());

    // SkillsRoutes aggregate
    let routes = SkillsRoutes::new(vec![skill_dir, missing_dir]);
    let res = routes.get_skills().await;
    assert_eq!(res.skills.len(), 1);
    assert_eq!(res.directories.len(), 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// FS Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_fs_check_and_complete() {
    let tmp = tempdir().unwrap();
    let repo_dir = tmp.path().join("repo");
    tokio::fs::create_dir_all(&repo_dir).await.unwrap();
    init_git_repo(&repo_dir);

    let non_git_dir = tmp.path().join("plain-dir");
    tokio::fs::create_dir_all(&non_git_dir).await.unwrap();

    let file_path = tmp.path().join("file.txt");
    tokio::fs::write(&file_path, "hello").await.unwrap();

    let routes = FsRoutes::new();

    // Validation: null byte
    let err = routes.check("/tmp/null\0byte").await.unwrap_err();
    assert_eq!(err.error_code(), "validation_error");
    assert!(matches!(err, FsRouteError::NullByte));

    // Validation: relative path
    let err = routes.check("relative/path").await.unwrap_err();
    assert!(matches!(err, FsRouteError::NotAbsolute(_)));

    // Non-existent path -> exists: false
    let check_missing = routes
        .check(&tmp.path().join("nope").to_string_lossy())
        .await
        .unwrap();
    assert!(!check_missing.exists);
    assert!(!check_missing.is_directory);
    assert!(!check_missing.is_git);
    assert!(check_missing.has_commits.is_none());

    // File path -> exists: true, is_directory: false
    let check_file = routes.check(&file_path.to_string_lossy()).await.unwrap();
    assert!(check_file.exists);
    assert!(!check_file.is_directory);
    assert!(!check_file.is_git);
    assert!(check_file.has_commits.is_none());

    // Plain dir -> is_directory: true, is_git: false
    let check_plain = routes.check(&non_git_dir.to_string_lossy()).await.unwrap();
    assert!(check_plain.exists);
    assert!(check_plain.is_directory);
    assert!(!check_plain.is_git);
    assert!(check_plain.has_commits.is_none());

    // Git repo -> is_git: true, has_commits: Some(true)
    let check_git = routes.check(&repo_dir.to_string_lossy()).await.unwrap();
    assert!(check_git.exists);
    assert!(check_git.is_directory);
    assert!(check_git.is_git);
    assert_eq!(check_git.has_commits, Some(true));

    // Complete: test directory listing & prefix matching
    let browse_dir = tmp.path().join("browse");
    tokio::fs::create_dir_all(&browse_dir).await.unwrap();
    tokio::fs::create_dir_all(browse_dir.join("alpha"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(browse_dir.join("alpine"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(browse_dir.join("beta"))
        .await
        .unwrap();
    tokio::fs::write(browse_dir.join("file_not_dir.txt"), "x")
        .await
        .unwrap();

    // Ends with slash -> list children of browse_dir
    let comp_all = routes
        .complete(&format!("{}/", browse_dir.to_string_lossy()))
        .await
        .unwrap();
    assert_eq!(comp_all.entries.len(), 3);
    assert_eq!(comp_all.entries[0].name, "alpha");
    assert_eq!(comp_all.entries[1].name, "alpine");
    assert_eq!(comp_all.entries[2].name, "beta");
    assert!(!comp_all.truncated);

    // Prefix matching "alp" -> matches "alpha" and "alpine"
    let comp_prefix = routes
        .complete(&format!("{}/alp", browse_dir.to_string_lossy()))
        .await
        .unwrap();
    assert_eq!(comp_prefix.entries.len(), 2);
    assert_eq!(comp_prefix.entries[0].name, "alpha");
    assert_eq!(comp_prefix.entries[1].name, "alpine");

    // Tilde expansion test
    let expanded = expand_tilde("~/test");
    assert!(!expanded.to_string_lossy().starts_with('~'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_attachments_upload_and_delete() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();

    let paths = Paths::with_home(tmp.path().join(".vibe-station"));
    let reg = AttachmentRegistry::new();
    let routes = AttachmentRoutes::new(store.clone(), paths.clone(), reg.clone());

    // Setup project and worktree
    let checkout = tmp.path().join("checkout");
    tokio::fs::create_dir_all(&checkout).await.unwrap();

    let agent_session = SessionRecord {
        id: "s-agent-1".into(),
        worktree_id: Some("wt-1".into()),
        project_id: "p-1".into(),
        is_main: true,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("mode-1".into()),
        name: Some("Agent".into()),
        name_source: None,
        tmux_name: "tmux-1".into(),
        use_tmux: true,
        channel: Some(Channel::Tmux),
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
            last_transition_at: "2026-01-01T00:00:00Z".into(),
        },
    };

    let term_session = SessionRecord {
        id: "s-term-1".into(),
        worktree_id: Some("wt-1".into()),
        project_id: "p-1".into(),
        is_main: false,
        sort_order: 2.0,
        r#type: SessionType::Terminal,
        mode_id: None,
        name: Some("Term".into()),
        name_source: None,
        tmux_name: "tmux-2".into(),
        use_tmux: true,
        channel: Some(Channel::Tmux),
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
            last_transition_at: "2026-01-01T00:00:00Z".into(),
        },
    };

    let worktree = WorktreeRecord {
        id: "wt-1".into(),
        name: None,
        branch: "main".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0000000".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        sessions: vec![agent_session.clone(), term_session.clone()],
    };

    let project = ProjectRecord {
        id: "p-1".into(),
        absolute_path: checkout.to_string_lossy().to_string(),
        prefix: "p1".into(),
        is_git: false,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![worktree],
        next_worktree_num: Some(2),
    };

    store.add_project(project.clone()).await.unwrap();

    // 404 on missing session
    let err = routes
        .upload_attachments(
            "missing-s",
            vec![UploadPart {
                filename: "foo.txt".into(),
                content_type: None,
                data: b"data".to_vec(),
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::SessionNotFound(_)));

    // 400 on terminal session
    let err = routes
        .upload_attachments(
            "s-term-1",
            vec![UploadPart {
                filename: "foo.txt".into(),
                content_type: None,
                data: b"data".to_vec(),
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::NotAgentSession(_)));

    // 400 on empty parts
    let err = routes
        .upload_attachments("s-agent-1", vec![])
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::NoFilesProvided));

    // Path traversal in filename is sanitized to its basename ("passwd")
    let traversal_res = routes
        .upload_attachments(
            "s-agent-1",
            vec![UploadPart {
                filename: "../../../etc/passwd".into(),
                content_type: None,
                data: b"hacked".to_vec(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(traversal_res.attachments[0].name, "passwd");
    // After sanitize_filename, "../../../etc/passwd" returns "passwd" which is valid basename
    // But empty or "." or ".." is invalid:
    assert!(sanitize_filename("..").is_none());
    assert!(sanitize_filename("").is_none());
    assert!(sanitize_filename("foo\0bar").is_none());

    let err = routes
        .upload_attachments(
            "s-agent-1",
            vec![UploadPart {
                filename: "..".into(),
                content_type: None,
                data: b"data".to_vec(),
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::InvalidFilename(_)));

    // 413 on file too large
    let err = routes
        .upload_attachments(
            "s-agent-1",
            vec![UploadPart {
                filename: "huge.bin".into(),
                content_type: None,
                data: vec![0u8; MAX_FILE_BYTES + 1],
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::FileTooLarge(_)));

    // Successful upload
    let upload_res = routes
        .upload_attachments(
            "s-agent-1",
            vec![UploadPart {
                filename: "doc.pdf".into(),
                content_type: Some("application/pdf".into()),
                data: b"%PDF-test-data".to_vec(),
            }],
        )
        .await
        .unwrap();

    assert_eq!(upload_res.attachments.len(), 1);
    let att = &upload_res.attachments[0];
    assert_eq!(att.name, "doc.pdf");
    assert_eq!(att.mime, "application/pdf");
    assert_eq!(att.size, b"%PDF-test-data".len() as i64);

    // File exists on disk in session uploads
    let file_on_disk = PathBuf::from(&att.path);
    assert!(file_on_disk.exists());

    // Because session channel is Tmux (non-json), pending-upload ref file was staged
    let ref_file = pending_upload_ref_path(
        &paths,
        &project,
        Some(&project.worktrees[0]),
        "s-agent-1",
        &att.id,
        &att.name,
    );
    assert!(ref_file.exists());
    let ref_content = tokio::fs::read_to_string(&ref_file).await.unwrap();
    assert_eq!(ref_content, att.path);

    // DELETE attachment
    let del_res = routes
        .delete_attachment("s-agent-1", &att.id)
        .await
        .unwrap();
    assert!(del_res.ok);

    // Registry cleared, file removed, ref file removed
    assert!(!file_on_disk.exists());
    assert!(!ref_file.exists());
    assert!(reg.get_attachment("s-agent-1", &att.id).is_none());

    // DELETE on already deleted -> 404
    let err = routes
        .delete_attachment("s-agent-1", &att.id)
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentRouteError::UploadNotFound(_)));
}
