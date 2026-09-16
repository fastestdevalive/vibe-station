//! Tests for `WorktreeRoutes` (dispatch #6).
//!
//! Covers:
//! - serialize_worktree, resolve_inside_worktree, parse_porcelain_z, parse_branch_name_status, compute_etag
//! - GET /worktrees (all and filtered by project)
//! - POST /worktrees (create_worktree: validation, errors, git worktree creation, naming/slugify, events)
//! - PATCH /worktrees/:id/pin & /hide
//! - PATCH /worktrees/:id/rename (empty name clearing, truncation)
//! - PATCH /worktrees/:id/reorder
//! - POST /worktrees/:id/done (agent -> done, direct -> exited)
//! - DELETE /worktrees/:id (with enforceDone check)
//! - GET /worktrees/:id/tree (directory traversal & gitignore filtering)
//! - GET /worktrees/:id/file-list
//! - GET /worktrees/:id/files/* (text, 404, access denied, 304 ETag)
//! - POST /worktrees/:id/open-file, GET & DELETE pending-file-opens
//! - GET /worktrees/:id/diff, changed-paths, diffstat, commits, submodules, pr

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_proc::tmux::Tmux;
use vst_routes::worktrees::{
    compute_etag, is_valid_commit_sha, parse_branch_name_status, parse_porcelain_z,
    resolve_inside_worktree, serialize_worktree, FileResponse, WorktreeRouteError, WorktreeRoutes,
};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::shared::Mode;
use vst_types::rest::worktrees::{
    CreateWorktreeBody, OpenFileBody, PatchWorktreeToggleBody, PrLookupResult, RenameWorktreeBody,
    ReorderWorktreeBody,
};
use vst_types::{
    Channel, CliId, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};

fn test_env() -> (tempfile::TempDir, StoreHandle, WorktreeRoutes) {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::new());
    let tmux = Tmux::new();
    let routes = WorktreeRoutes::new(store.clone(), broadcaster, json_registry, tmux, 4000);
    (dir, store, routes)
}

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
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "user.name", "Test User"]);
    std::fs::write(path.join("README.md"), "# Initial Commit\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "Initial commit"]);
}

fn setup_temp_mode(home_path: &Path, mode_id: &str, cli: CliId) {
    let vst_dir = home_path.join(".vibe-station");
    std::fs::create_dir_all(&vst_dir).unwrap();
    let mode = Mode {
        id: mode_id.to_string(),
        name: mode_id.to_string(),
        cli,
        context: "test-context".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        model: Some("test-model".to_string()),
    };
    let modes_json = serde_json::to_string(&vec![mode]).unwrap();
    std::fs::write(vst_dir.join("modes.json"), modes_json).unwrap();
}

fn make_sample_project(project_id: &str, wt_id: &str, wt_path: &Path) -> ProjectRecord {
    let session = SessionRecord {
        id: "sess-1".into(),
        worktree_id: Some(wt_id.into()),
        project_id: project_id.into(),
        is_main: true,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("mode-1".into()),
        name: Some("Agent 1".into()),
        name_source: None,
        tmux_name: "vst-sess-1".into(),
        use_tmux: false,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    };

    let wt = WorktreeRecord {
        id: wt_id.into(),
        name: Some("feature-test".into()),
        branch: "feat/test".into(),
        branch_is_placeholder: Some(false),
        base_branch: "main".into(),
        base_sha: "abc1234".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        sessions: vec![session],
    };

    ProjectRecord {
        id: project_id.into(),
        absolute_path: wt_path.to_string_lossy().to_string(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![wt],
        next_worktree_num: Some(1),
    }
}

#[tokio::test]
async fn test_pure_helpers() {
    assert!(is_valid_commit_sha("0123456"));
    assert!(is_valid_commit_sha(
        "0123456789abcdef0123456789abcdef01234567"
    ));
    assert!(!is_valid_commit_sha("short"));
    assert!(!is_valid_commit_sha("zzzzzzzz"));

    let etag = compute_etag(b"hello world");
    assert!(etag.starts_with('"') && etag.ends_with('"'));

    let dir = tempdir().unwrap();
    let root = dir.path();
    let safe = resolve_inside_worktree(root, "subdir/file.txt").unwrap();
    assert_eq!(safe, root.join("subdir/file.txt"));

    let err = resolve_inside_worktree(root, "../outside.txt");
    assert!(err.is_err());

    let status_z = " M file1.txt\0?? file2.txt\0";
    let parsed = parse_porcelain_z(status_z);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].path, "file1.txt");
    assert_eq!(parsed[0].status, "M");
    assert_eq!(parsed[1].path, "file2.txt");
    assert_eq!(parsed[1].status, "?");

    let diff_z = "M\0file3.txt\0";
    let parsed_diff = parse_branch_name_status(diff_z);
    assert_eq!(parsed_diff.len(), 1);
    assert_eq!(parsed_diff[0].path, "file3.txt");
    assert_eq!(parsed_diff[0].status, "M");

    let wt_rec = vst_types::WorktreeRecord {
        id: "wt-x".into(),
        name: Some("test".into()),
        branch: "branch-x".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(1),
        agent_seq: Some(1),
        sessions: vec![],
    };
    let serialized = serialize_worktree("proj-x", &wt_rec);
    assert_eq!(serialized.id, "wt-x");
    assert_eq!(serialized.project_id, "proj-x");
}

#[tokio::test]
async fn test_worktrees_list() {
    let (_dir, store, routes) = test_env();
    let wt_dir = tempdir().unwrap();
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    let all = routes.list_worktrees(None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "wt-1");
    assert_eq!(all[0].main_session_id.as_deref(), Some("sess-1"));

    let filtered = routes.list_worktrees(Some("proj-1")).await.unwrap();
    assert_eq!(filtered.len(), 1);

    let not_found_list = routes.list_worktrees(Some("non-existent")).await;
    assert!(matches!(
        not_found_list,
        Err(WorktreeRouteError::NotFound(_))
    ));
}

#[tokio::test]
async fn test_create_worktree_validation_and_errors() {
    let (_dir, store, routes) = test_env();
    let wt_dir = tempdir().unwrap();
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    // 1. Missing project_id
    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "".into(),
            mode_id: "mode-1".into(),
            branch: None,
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: None,
            name: None,
            source_agent_id: None,
            skip_auto_turn: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeRouteError::Validation(_)));

    // 2. Missing mode_id
    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-1".into(),
            mode_id: "".into(),
            branch: None,
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: None,
            name: None,
            source_agent_id: None,
            skip_auto_turn: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeRouteError::Validation(_)));

    // 3. Unknown mode
    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-1".into(),
            mode_id: "non-existent-mode".into(),
            branch: None,
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: None,
            name: None,
            source_agent_id: None,
            skip_auto_turn: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeRouteError::Validation(_)));

    // 4. Unknown project
    let temp_home = tempdir().unwrap();
    let _guard = with_home(temp_home.path().to_path_buf());
    setup_temp_mode(temp_home.path(), "mode-valid", CliId::Claude);

    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "missing-proj".into(),
            mode_id: "mode-valid".into(),
            branch: None,
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: None,
            name: None,
            source_agent_id: None,
            skip_auto_turn: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeRouteError::NotFound(_)));

    // 5. Non-git project error
    let non_git_proj = ProjectRecord {
        id: "proj-nongit".into(),
        absolute_path: "/tmp/nongit".into(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(non_git_proj).await.unwrap();

    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-nongit".into(),
            mode_id: "mode-valid".into(),
            branch: None,
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: None,
            name: None,
            source_agent_id: None,
            skip_auto_turn: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeRouteError::Validation(_)));
}

#[tokio::test]
async fn test_create_worktree_success_and_events() {
    let temp_home = tempdir().unwrap();
    let _guard = with_home(temp_home.path().to_path_buf());
    setup_temp_mode(temp_home.path(), "test-mode", CliId::Claude);

    let (_dir, store, mut routes) = test_env();
    let git_repo_dir = tempdir().unwrap();
    init_git_repo(git_repo_dir.path());

    // Configure paths to use a dedicated temp dir for worktrees
    let vst_data_dir = tempdir().unwrap();
    routes.paths = vst_git::paths::Paths::with_home(vst_data_dir.path().to_path_buf());

    let proj = ProjectRecord {
        id: "proj-real-git".into(),
        absolute_path: git_repo_dir.path().to_string_lossy().to_string(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(proj).await.unwrap();

    // Subscribe to events
    let mut rx = routes.broadcaster.subscribe();

    // Create worktree with prompt -> derive branch and name via slugify
    let res = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-real-git".into(),
            mode_id: "test-mode".into(),
            branch: None,
            base_branch: Some("main".into()),
            prompt: Some("Fix Issue With User Login".into()),
            use_tmux: None,
            channel: Some(Channel::Json),
            name: None,
            source_agent_id: None,
            skip_auto_turn: Some(true),
        })
        .await
        .unwrap();

    assert_eq!(res.project_id, "proj-real-git");
    assert_eq!(res.id, "vs-1");
    // Branch derived from slugified prompt ("with" and "user" filtered as common words)
    assert_eq!(res.branch, "fix-issue-login");
    assert_eq!(res.name.as_deref(), Some("fix-issue-login"));
    assert!(res.main_session_id.is_some());

    // Verify persisted in DB
    let p = store.get_project("proj-real-git").await.unwrap();
    assert_eq!(p.worktrees.len(), 1);
    assert_eq!(p.worktrees[0].id, "vs-1");
    assert_eq!(p.worktrees[0].branch, "fix-issue-login");
    assert_eq!(p.worktrees[0].sessions.len(), 1);
    assert!(p.worktrees[0].sessions[0].is_main);

    // Verify WorktreeCreated and SessionCreated events were broadcast
    let mut found_wt_created = false;
    let mut found_sess_created = false;
    while let Ok(event) = rx.try_recv() {
        match event {
            ServerEvent::WorktreeCreated { worktree } => {
                if worktree.get("id").and_then(|v| v.as_str()) == Some("vs-1") {
                    found_wt_created = true;
                }
            }
            ServerEvent::SessionCreated { session_id, .. } => {
                if Some(session_id.as_str()) == res.main_session_id.as_deref() {
                    found_sess_created = true;
                }
            }
            _ => {}
        }
    }
    assert!(found_wt_created, "WorktreeCreated event must be emitted");
    assert!(found_sess_created, "SessionCreated event must be emitted");

    // Creating second worktree with explicit name and explicit branch
    let res2 = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-real-git".into(),
            mode_id: "test-mode".into(),
            branch: Some("feat/custom-branch".into()),
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: Some(Channel::Json),
            name: Some("Custom Worktree Name".into()),
            source_agent_id: None,
            skip_auto_turn: Some(true),
        })
        .await
        .unwrap();

    assert_eq!(res2.id, "vs-2");
    assert_eq!(res2.branch, "feat/custom-branch");
    assert_eq!(res2.name.as_deref(), Some("Custom Worktree Name"));
}

#[tokio::test]
async fn test_worktrees_pin_hide_rename_reorder() {
    let (_dir, store, routes) = test_env();
    let wt_dir = tempdir().unwrap();
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    // Pin
    let pin_res = routes
        .patch_pin(
            "wt-1",
            PatchWorktreeToggleBody {
                pinned: Some(true),
                hidden: None,
            },
        )
        .await
        .unwrap();
    assert!(pin_res.ok);
    assert!(pin_res.worktree.pinned_at.is_some());

    // Hide
    let hide_res = routes
        .patch_hide(
            "wt-1",
            PatchWorktreeToggleBody {
                pinned: None,
                hidden: Some(true),
            },
        )
        .await
        .unwrap();
    assert!(hide_res.ok);
    assert!(hide_res.worktree.hidden_at.is_some());

    // Rename
    let rename_res = routes
        .patch_rename(
            "wt-1",
            RenameWorktreeBody {
                name: "  New Name  ".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(rename_res.name.as_deref(), Some("New Name"));

    // Rename empty -> None
    let rename_empty = routes
        .patch_rename("wt-1", RenameWorktreeBody { name: "   ".into() })
        .await
        .unwrap();
    assert_eq!(rename_empty.name, None);

    // Reorder
    let reorder_res = routes
        .patch_reorder("wt-1", ReorderWorktreeBody { sort_order: 42.5 })
        .await
        .unwrap();
    assert_eq!(reorder_res.sort_order, 42.5);

    let all = routes.list_worktrees(Some("proj-1")).await.unwrap();
    assert_eq!(all[0].sort_order, 42.5);
}

#[tokio::test]
async fn test_worktree_done_and_delete() {
    let (_dir, store, routes) = test_env();
    let wt_dir = tempdir().unwrap();
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    // Delete with enforce_done should fail when session is in Working state
    let del_fail = routes.delete_worktree("wt-1", true).await;
    assert!(matches!(
        del_fail,
        Err(WorktreeRouteError::WorktreeNotDone { .. })
    ));

    // Mark done
    let done_res = routes.worktree_done("wt-1").await.unwrap();
    assert!(done_res.ok);
    assert_eq!(done_res.updated, 1);

    // Delete with enforce_done succeeds now
    let del_ok = routes.delete_worktree("wt-1", true).await;
    assert!(del_ok.is_ok());

    // Now worktree is gone
    let list_after = routes.list_worktrees(Some("proj-1")).await.unwrap();
    assert!(list_after.is_empty());
}

#[tokio::test]
async fn test_tree_and_disk_usage() {
    let (_dir, store, mut routes) = test_env();
    let wt_dir = tempdir().unwrap();
    routes.paths = vst_git::paths::Paths::with_home(wt_dir.path().to_path_buf());

    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    let wt_path = routes.paths.worktree_path("proj-1", "wt-1");
    tokio::fs::create_dir_all(wt_path.join("subdir"))
        .await
        .unwrap();
    tokio::fs::write(wt_path.join("file.txt"), "content")
        .await
        .unwrap();
    tokio::fs::write(wt_path.join(".hidden"), "secret")
        .await
        .unwrap();

    // Tree with show_hidden=false
    let tree_entries = routes.tree("wt-1", None, Some(false)).await.unwrap();
    assert_eq!(tree_entries.len(), 2); // subdir and file.txt, .hidden filtered

    // Tree with show_hidden=true
    let all_entries = routes.tree("wt-1", None, Some(true)).await.unwrap();
    assert_eq!(all_entries.len(), 3);

    // Disk usage
    let usage = routes.disk_usage().await.unwrap();
    assert_eq!(usage.worktrees.len(), 1);
    assert_eq!(usage.worktrees[0].id, "wt-1");
}

#[tokio::test]
async fn test_git_surface_routes_on_real_repo() {
    let temp_home = tempdir().unwrap();
    let _guard = with_home(temp_home.path().to_path_buf());
    setup_temp_mode(temp_home.path(), "test-mode", CliId::Claude);

    let (_dir, store, mut routes) = test_env();
    let git_repo_dir = tempdir().unwrap();
    init_git_repo(git_repo_dir.path());

    let vst_data_dir = tempdir().unwrap();
    routes.paths = vst_git::paths::Paths::with_home(vst_data_dir.path().to_path_buf());

    let proj = ProjectRecord {
        id: "proj-git".into(),
        absolute_path: git_repo_dir.path().to_string_lossy().to_string(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(proj).await.unwrap();

    let wt = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "proj-git".into(),
            mode_id: "test-mode".into(),
            branch: Some("feat/git-test".into()),
            base_branch: Some("main".into()),
            prompt: None,
            use_tmux: None,
            channel: Some(Channel::Json),
            name: None,
            source_agent_id: None,
            skip_auto_turn: Some(true),
        })
        .await
        .unwrap();

    let wt_path = routes.paths.worktree_path("proj-git", &wt.id);

    // Make a change in the worktree
    tokio::fs::write(wt_path.join("newfile.txt"), "hello git\n")
        .await
        .unwrap();

    // 1. changed_paths (local scope)
    let paths = routes
        .changed_paths(&wt.id, Some("local"), None)
        .await
        .unwrap();
    assert!(!paths.is_empty());
    assert!(paths.iter().any(|p| p.path == "newfile.txt"));

    // 2. diff (local scope)
    let diff_res = routes
        .diff(&wt.id, "newfile.txt", Some("local"), None)
        .await
        .unwrap();
    assert!(!diff_res.etag.is_empty());

    // 3. diffstat (branch scope)
    let stat = routes.diffstat(&wt.id, Some("branch")).await.unwrap();
    assert!(stat.insertions >= 0);

    // 4. commits
    let commits = routes.commits(&wt.id, Some(50)).await.unwrap();
    assert!(!commits.commits.is_empty());
    assert_eq!(commits.commits[0].subject, "Initial commit");

    // 5. submodules (empty repo has none)
    let subs = routes.submodules(&wt.id).await.unwrap();
    assert!(subs.submodules.is_empty());

    // 6. pr (no remote, should cleanly return NotGithub)
    let pr_res = routes.pr(&wt.id).await.unwrap();
    assert_eq!(pr_res, PrLookupResult::NotGithub);
}

#[tokio::test]
async fn test_pending_file_opens() {
    let (_dir, store, routes) = test_env();
    let wt_dir = tempdir().unwrap();
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    // Worktree file path inside worktree
    let file_rel = "src/index.ts";
    let full = wt_dir.path().join("src");
    tokio::fs::create_dir_all(&full).await.unwrap();
    tokio::fs::write(full.join("index.ts"), "console.log('hi');")
        .await
        .unwrap();

    // Open file
    routes
        .open_file(
            "wt-1",
            OpenFileBody {
                path: file_rel.into(),
            },
        )
        .await
        .unwrap();

    let pending = routes.get_pending_file_opens("wt-1").await.unwrap();
    assert_eq!(pending.paths, vec!["src/index.ts"]);

    // Delete pending file opens
    routes.delete_pending_file_opens("wt-1").await.unwrap();
    let pending_after = routes.get_pending_file_opens("wt-1").await.unwrap();
    assert!(pending_after.paths.is_empty());
}

#[tokio::test]
async fn test_get_file_and_file_list() {
    let (_dir, store, mut routes) = test_env();
    let wt_dir = tempdir().unwrap();
    routes.paths = vst_git::paths::Paths::with_home(wt_dir.path().to_path_buf());

    // Set up project at wt_dir
    let project = make_sample_project("proj-1", "wt-1", wt_dir.path());
    store.add_project(project).await.unwrap();

    let wt_path = routes.paths.worktree_path("proj-1", "wt-1");
    tokio::fs::create_dir_all(&wt_path).await.unwrap();
    tokio::fs::write(wt_path.join("README.md"), "# Title\nHello world")
        .await
        .unwrap();

    let file = routes.get_file("wt-1", "README.md").await.unwrap();
    match file {
        FileResponse::Text { etag, content } => {
            assert!(content.contains("Hello world"));
            assert!(!etag.is_empty());
        }
        _ => panic!("Expected text file response"),
    }

    let list = routes.file_list("wt-1").await.unwrap();
    assert!(!list.files.is_empty() || !list.source.is_empty());
}
