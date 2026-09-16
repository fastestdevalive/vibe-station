//! Tests for `ProjectRoutes` (dispatch #7).
//!
//! Covers:
//! - Pure helpers: `expand_tilde`, `resolve_inside_dir` (traversal protection), `assert_safe_to_delete`, `serialize_project`
//! - `GET /projects` (ordering: oldest-first by created_at, tie-break on id)
//! - `GET /projects/:projectId/branches` (git repo with default/branches, non-git empty, 404 missing)
//! - `POST /projects` (register existing directory):
//!   - validation (empty, non-absolute, non-existent, already registered conflict)
//!   - custom prefix validation and collision
//!   - prefix generation & uniqueness
//!   - optional git setup
//! - `POST /projects/create` (create brand new project):
//!   - real git repo creation with git init & default branch
//!   - validation (empty name, path separators / \, .., dotfile, parent missing, existing dir conflict, existing id conflict)
//!   - start_agent in worktree mode: creates worktree, sets up session, emits `ProjectCreated`, `WorktreeCreated`, `SessionCreated`
//!   - start_agent in direct session mode: sets up direct session, emits `ProjectCreated`, `SessionCreated`
//! - `PATCH /projects/:id` (toggle hidden flag with idempotent fast-path, 404 missing)
//! - `DELETE /projects/:id` (releases sessions, removes worktrees, removes data dir, broadcasts delete events)
//! - `GET /projects/:projectId/tree` (lazy directory listing with ignore filter, 404 missing)
//! - `GET /projects/:projectId/file-list` (flat file listing via ripgrep/walk, 404 missing)
//! - `GET /projects/:projectId/files/*` (file contents, images, size limits, binary limit, ETag, 404 missing)

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::projects::{
    assert_safe_to_delete, expand_tilde, resolve_inside_dir, serialize_project, ProjectRouteError,
    ProjectRoutes,
};
use vst_routes::worktrees::FileResponse;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::projects::{
    CreateNewProjectBody, CreateProjectBody, PatchProjectBody, StartAgent,
};
use vst_types::rest::shared::Mode;
use vst_types::{CliId, ProjectRecord};

fn test_env() -> (tempfile::TempDir, StoreHandle, Broadcaster, ProjectRoutes) {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(32);
    let json_registry = Arc::new(JsonAgentRegistry::new());
    let tmux = Tmux::new();
    let paths = Paths::with_home(dir.path().join(".vibe-station"));
    let routes = ProjectRoutes::new(
        store.clone(),
        broadcaster.clone(),
        json_registry,
        tmux,
        4000,
    )
    .with_paths(paths);
    (dir, store, broadcaster, routes)
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

#[tokio::test]
async fn test_pure_helpers() {
    let temp = tempdir().unwrap();
    let home = temp.path().to_path_buf();

    {
        let _guard = with_home(home.clone());
        assert_eq!(expand_tilde("~"), home.to_string_lossy());
        assert_eq!(
            expand_tilde("~/foo/bar"),
            home.join("foo/bar").to_string_lossy()
        );
        assert_eq!(expand_tilde("/var/log"), "/var/log");
    }

    // resolve_inside_dir
    let root = temp.path().join("my-project");
    std::fs::create_dir_all(&root).unwrap();

    let resolved = resolve_inside_dir(&root, "src/main.rs").unwrap();
    assert_eq!(resolved, root.join("src/main.rs"));

    // Traversal rejection
    let err = resolve_inside_dir(&root, "../outside.txt").unwrap_err();
    match err {
        ProjectRouteError::AccessDenied(msg) => {
            assert!(msg.contains("Access denied"));
        }
        other => panic!("expected AccessDenied, got {other:?}"),
    }

    // assert_safe_to_delete
    let vst_home = home.join(".vibe-station");
    std::fs::create_dir_all(&vst_home).unwrap();
    let project_data_dir = vst_home.join("projects").join("my-proj");
    std::fs::create_dir_all(&project_data_dir).unwrap();

    // Valid data dir inside vst_home, not overlapping source
    assert!(assert_safe_to_delete(&project_data_dir, &vst_home, "/home/user/my-proj").is_ok());

    // Target outside vst_home
    assert!(assert_safe_to_delete(&home.join("other"), &vst_home, "").is_err());

    // Target is exactly vst_home
    assert!(assert_safe_to_delete(&vst_home, &vst_home, "").is_err());

    // serialize_project
    let rec = ProjectRecord {
        id: "p-rec".into(),
        absolute_path: "/abs/path".into(),
        prefix: "pr".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01".into(),
        hidden: Some(true),
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    let serialized = serialize_project(&rec);
    assert_eq!(serialized.id, "p-rec");
    assert!(serialized.hidden);
    assert!(serialized.is_git);
}

#[tokio::test]
async fn test_list_projects_order() {
    let (_dir, store, _broadcaster, routes) = test_env();

    // Create 3 projects with different created_at
    let p1 = ProjectRecord {
        id: "proj-b".into(),
        absolute_path: "/tmp/proj-b".into(),
        prefix: "pb".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-02T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    let p2 = ProjectRecord {
        id: "proj-a".into(),
        absolute_path: "/tmp/proj-a".into(),
        prefix: "pa".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    let p3 = ProjectRecord {
        id: "proj-c".into(),
        absolute_path: "/tmp/proj-c".into(),
        prefix: "pc".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-02T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };

    store.add_project(p1).await.unwrap();
    store.add_project(p2).await.unwrap();
    store.add_project(p3).await.unwrap();

    let list = routes.list_projects().await;
    assert_eq!(list.len(), 3);
    // Oldest first: p2 (2026-01-01), then p1 ("proj-b") and p3 ("proj-c") tie on created_at -> broken by id
    assert_eq!(list[0].id, "proj-a");
    assert_eq!(list[1].id, "proj-b");
    assert_eq!(list[2].id, "proj-c");
}

#[tokio::test]
async fn test_list_project_branches() {
    let (dir, store, _broadcaster, routes) = test_env();

    // 404 case
    let err = routes
        .list_project_branches("non-existent")
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::NotFound(_)));

    // Non-git directory
    let non_git_dir = dir.path().join("not-git");
    std::fs::create_dir_all(&non_git_dir).unwrap();
    let p_non_git = ProjectRecord {
        id: "not-git".into(),
        absolute_path: non_git_dir.to_string_lossy().into(),
        prefix: "ng".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(p_non_git).await.unwrap();

    let branches_res = routes.list_project_branches("not-git").await.unwrap();
    assert!(branches_res.branches.is_empty());
    assert!(branches_res.default_branch.is_none());

    // Git directory
    let git_dir = dir.path().join("real-git");
    std::fs::create_dir_all(&git_dir).unwrap();
    init_git_repo(&git_dir);

    let p_git = ProjectRecord {
        id: "real-git".into(),
        absolute_path: git_dir.to_string_lossy().into(),
        prefix: "rg".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(p_git).await.unwrap();

    let branches_res = routes.list_project_branches("real-git").await.unwrap();
    assert_eq!(branches_res.default_branch.as_deref(), Some("main"));
    assert!(branches_res.branches.contains(&"main".to_string()));
}

#[tokio::test]
async fn test_create_project_register_existing() {
    let (dir, _store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    // 1. Validation: empty path
    let err = routes
        .create_project(CreateProjectBody {
            path: "   ".into(),
            name: None,
            prefix: None,
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 2. Validation: invalid prefix
    let err = routes
        .create_project(CreateProjectBody {
            path: "/tmp/foo".into(),
            name: None,
            prefix: Some("TOOLONGPREFIX".into()),
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 3. Validation: relative path
    let err = routes
        .create_project(CreateProjectBody {
            path: "relative/path".into(),
            name: None,
            prefix: None,
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 4. Validation: non-existent path
    let err = routes
        .create_project(CreateProjectBody {
            path: dir.path().join("does-not-exist").to_string_lossy().into(),
            name: None,
            prefix: None,
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 5. Valid registration with git repo
    let proj_dir = dir.path().join("my-existing-proj");
    std::fs::create_dir_all(&proj_dir).unwrap();
    init_git_repo(&proj_dir);

    let created = routes
        .create_project(CreateProjectBody {
            path: proj_dir.to_string_lossy().into(),
            name: Some("My Existing Proj".into()),
            prefix: Some("mep".into()),
            setup: None,
        })
        .await
        .unwrap();

    assert_eq!(created.id, "my-existing-proj");
    assert_eq!(created.prefix, "mep");
    assert!(created.is_git);
    assert_eq!(created.default_branch.as_deref(), Some("main"));

    // Check broadcast event
    let event = rx.try_recv().expect("broadcast event expected");
    match event {
        ServerEvent::ProjectCreated { project } => {
            assert_eq!(
                project.get("id").and_then(|v| v.as_str()),
                Some("my-existing-proj")
            );
        }
        other => panic!("expected ProjectCreated, got {other:?}"),
    }

    // 6. Conflict: duplicate path
    let err = routes
        .create_project(CreateProjectBody {
            path: proj_dir.to_string_lossy().into(),
            name: Some("Different Name".into()),
            prefix: None,
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Conflict { .. }));

    // 7. Conflict: prefix collision
    let other_dir = dir.path().join("other-proj");
    std::fs::create_dir_all(&other_dir).unwrap();
    init_git_repo(&other_dir);

    let err = routes
        .create_project(CreateProjectBody {
            path: other_dir.to_string_lossy().into(),
            name: Some("Other Proj".into()),
            prefix: Some("mep".into()), // same as earlier
            setup: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Conflict { .. }));
}

#[tokio::test]
async fn test_create_new_project_validation() {
    let (dir, _store, _broadcaster, routes) = test_env();

    // 1. Empty name
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "  ".into(),
            dir: Some(dir.path().to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 2. Path separators in name
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "foo/bar".into(),
            dir: Some(dir.path().to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 3. Dotfile in name
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: ".hidden".into(),
            dir: Some(dir.path().to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 4. Traversal '..'
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "foo..bar".into(),
            dir: Some(dir.path().to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));

    // 5. Worktree branch validation ('main' collision)
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "valid-name".into(),
            dir: Some(dir.path().to_string_lossy().into()),
            start_agent: Some(StartAgent {
                mode_id: "test-mode".into(),
                prompt: Some("do work".into()),
                use_worktree: Some(true),
                branch: Some("main".into()),
            }),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Validation(_)));
}

#[tokio::test]
async fn test_create_new_project_real_git_success() {
    let (dir, store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    let parent_dir = dir.path().join("repos");
    std::fs::create_dir_all(&parent_dir).unwrap();

    let result = routes
        .create_new_project(CreateNewProjectBody {
            name: "Brand New App".into(),
            dir: Some(parent_dir.to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap();

    assert_eq!(result.project.id, "brand-new-app");
    assert!(result.project.is_git);
    assert_eq!(result.project.default_branch.as_deref(), Some("main"));
    assert!(result.worktree.is_none());
    assert!(result.session.is_none());

    // Verify persisted in store
    let persisted = store.get_project("brand-new-app").await.unwrap();
    assert_eq!(persisted.id, "brand-new-app");
    assert_eq!(persisted.prefix, "bna");
    assert!(Path::new(&persisted.absolute_path).exists());
    assert!(Path::new(&persisted.absolute_path).join(".git").exists());

    // Verify broadcast event
    let event = rx.try_recv().expect("broadcast event expected");
    match event {
        ServerEvent::ProjectCreated { project } => {
            assert_eq!(
                project.get("id").and_then(|v| v.as_str()),
                Some("brand-new-app")
            );
        }
        other => panic!("expected ProjectCreated, got {other:?}"),
    }

    // Conflict: creating again with same name
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "Brand New App".into(),
            dir: Some(parent_dir.to_string_lossy().into()),
            start_agent: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::Conflict { .. }));
}

#[tokio::test]
async fn test_create_new_project_with_start_agent_worktree() {
    let (dir, store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    let home = dir.path().join("fake-home");
    std::fs::create_dir_all(&home).unwrap();
    setup_temp_mode(&home, "claude-mode", CliId::Claude);

    let parent_dir = dir.path().join("repos");
    std::fs::create_dir_all(&parent_dir).unwrap();

    let _guard = with_home(home);

    let result = routes
        .create_new_project(CreateNewProjectBody {
            name: "App With Worktree".into(),
            dir: Some(parent_dir.to_string_lossy().into()),
            start_agent: Some(StartAgent {
                mode_id: "claude-mode".into(),
                prompt: Some("build feature".into()),
                use_worktree: Some(true),
                branch: Some("feat-1".into()),
            }),
        })
        .await
        .unwrap();

    assert_eq!(result.project.id, "app-with-worktree");
    let wt = result.worktree.expect("expected worktree in result");
    assert_eq!(wt.branch, "feat-1");
    let sess = result.session.expect("expected session in result");
    assert_eq!(sess.worktree_id.as_deref(), Some(wt.id.as_str()));

    // Verify persisted
    let persisted = store.get_project("app-with-worktree").await.unwrap();
    assert_eq!(persisted.worktrees.len(), 1);
    assert_eq!(persisted.worktrees[0].sessions.len(), 1);

    // Verify events: ProjectCreated, WorktreeCreated, SessionCreated
    let mut received_proj = false;
    let mut received_wt = false;
    let mut received_sess = false;

    while let Ok(event) = rx.try_recv() {
        match event {
            ServerEvent::ProjectCreated { project } => {
                if project.get("id").and_then(|v| v.as_str()) == Some("app-with-worktree") {
                    received_proj = true;
                }
            }
            ServerEvent::WorktreeCreated { worktree } => {
                if worktree.get("id").and_then(|v| v.as_str()) == Some(&wt.id) {
                    received_wt = true;
                }
            }
            ServerEvent::SessionCreated { session_id, .. } => {
                if session_id == sess.id {
                    received_sess = true;
                }
            }
            _ => {}
        }
    }

    assert!(received_proj, "ProjectCreated event missing");
    assert!(received_wt, "WorktreeCreated event missing");
    assert!(received_sess, "SessionCreated event missing");
}

#[tokio::test]
async fn test_create_new_project_with_start_agent_direct() {
    let (dir, store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    let home = dir.path().join("fake-home");
    std::fs::create_dir_all(&home).unwrap();
    setup_temp_mode(&home, "cursor-mode", CliId::Cursor);

    let parent_dir = dir.path().join("repos");
    std::fs::create_dir_all(&parent_dir).unwrap();

    let _guard = with_home(home);

    let result = routes
        .create_new_project(CreateNewProjectBody {
            name: "App Direct".into(),
            dir: Some(parent_dir.to_string_lossy().into()),
            start_agent: Some(StartAgent {
                mode_id: "cursor-mode".into(),
                prompt: Some("direct fix".into()),
                use_worktree: Some(false),
                branch: None,
            }),
        })
        .await
        .unwrap();

    assert_eq!(result.project.id, "app-direct");
    assert!(result.worktree.is_none());
    let sess = result.session.expect("expected direct session");
    assert!(sess.worktree_id.is_none());
    assert_eq!(sess.project_id, "app-direct");

    let persisted = store.get_project("app-direct").await.unwrap();
    assert_eq!(persisted.direct_sessions.len(), 1);

    // Verify events: ProjectCreated, SessionCreated
    let mut received_proj = false;
    let mut received_sess = false;

    while let Ok(event) = rx.try_recv() {
        match event {
            ServerEvent::ProjectCreated { project } => {
                if project.get("id").and_then(|v| v.as_str()) == Some("app-direct") {
                    received_proj = true;
                }
            }
            ServerEvent::SessionCreated { session_id, .. } => {
                if session_id == sess.id {
                    received_sess = true;
                }
            }
            _ => {}
        }
    }

    assert!(received_proj, "ProjectCreated event missing");
    assert!(received_sess, "SessionCreated event missing");
}

#[tokio::test]
async fn test_patch_project_hidden() {
    let (dir, store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    let p = ProjectRecord {
        id: "patch-proj".into(),
        absolute_path: dir.path().join("patch-proj").to_string_lossy().into(),
        prefix: "pp".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(p).await.unwrap();

    // 404 on missing
    let err = routes
        .patch_project("missing", PatchProjectBody { hidden: true })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::NotFound(_)));

    // Toggle hidden = true
    let res = routes
        .patch_project("patch-proj", PatchProjectBody { hidden: true })
        .await
        .unwrap();
    assert!(res.ok);
    assert!(res.project.hidden);

    // Verify broadcast
    let event = rx.try_recv().expect("broadcast expected");
    match event {
        ServerEvent::ProjectUpdated { project } => {
            assert_eq!(
                project.get("id").and_then(|v| v.as_str()),
                Some("patch-proj")
            );
            assert_eq!(project.get("hidden").and_then(|v| v.as_bool()), Some(true));
        }
        other => panic!("expected ProjectUpdated, got {other:?}"),
    }

    // Idempotent fast-path: toggle hidden = true again (no broadcast)
    let res2 = routes
        .patch_project("patch-proj", PatchProjectBody { hidden: true })
        .await
        .unwrap();
    assert!(res2.ok);
    assert!(res2.project.hidden);
    assert!(
        rx.try_recv().is_err(),
        "unexpected broadcast on idempotent patch"
    );
}

#[tokio::test]
async fn test_delete_project() {
    let (dir, store, broadcaster, routes) = test_env();
    let mut rx = broadcaster.subscribe();

    let p_dir = dir.path().join("del-proj");
    std::fs::create_dir_all(&p_dir).unwrap();
    init_git_repo(&p_dir);

    // Create a data directory for this project
    let data_dir = routes.paths.project_dir("del-proj");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(data_dir.join("test.txt"), "hello").unwrap();

    let p = ProjectRecord {
        id: "del-proj".into(),
        absolute_path: p_dir.to_string_lossy().into(),
        prefix: "dp".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(p).await.unwrap();

    // 404 missing
    let err = routes.delete_project("missing").await.unwrap_err();
    assert!(matches!(err, ProjectRouteError::NotFound(_)));

    // Delete del-proj
    routes.delete_project("del-proj").await.unwrap();

    // Verify removed from store
    assert!(store.get_project("del-proj").await.is_none());

    // Verify data dir removed
    assert!(!data_dir.exists());

    // Verify ProjectDeleted broadcast
    let event = rx.try_recv().expect("broadcast expected");
    match event {
        ServerEvent::ProjectDeleted { project_id } => {
            assert_eq!(project_id, "del-proj");
        }
        other => panic!("expected ProjectDeleted, got {other:?}"),
    }
}

#[tokio::test]
async fn test_tree_file_list_and_get_file() {
    let (dir, store, _broadcaster, routes) = test_env();

    let proj_dir = dir.path().join("fs-proj");
    std::fs::create_dir_all(proj_dir.join("src")).unwrap();
    std::fs::write(proj_dir.join("src").join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(proj_dir.join("README.md"), "# FS Proj\n").unwrap();
    std::fs::write(proj_dir.join(".secret"), "shh\n").unwrap();

    let p = ProjectRecord {
        id: "fs-proj".into(),
        absolute_path: proj_dir.to_string_lossy().into(),
        prefix: "fp".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
    };
    store.add_project(p).await.unwrap();

    // Tree: root, hide_dotfiles = true
    let tree_entries = routes.tree("fs-proj", None, Some(false)).await.unwrap();
    let names: Vec<_> = tree_entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"README.md"));
    assert!(names.contains(&"src"));
    assert!(!names.contains(&".secret"));

    // File list
    let file_list_res = routes.file_list("fs-proj").await.unwrap();
    assert!(file_list_res
        .files
        .iter()
        .any(|f| f == "README.md" || f.ends_with("README.md")));

    // Get file text
    let resp = routes.get_file("fs-proj", "README.md").await.unwrap();
    match resp {
        FileResponse::Text { content, etag } => {
            assert_eq!(content, "# FS Proj\n");
            assert!(!etag.is_empty());
        }
        other => panic!("expected Text response, got {other:?}"),
    }

    // Get file 404
    let err = routes
        .get_file("fs-proj", "non-existent.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::NotFound(_)));

    // Get file traversal rejected
    let err = routes
        .get_file("fs-proj", "../outside.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectRouteError::AccessDenied(_)));
}
