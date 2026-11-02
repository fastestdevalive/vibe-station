//! Regression tests for `WorktreeRoutes::pr` after the Phase 3 migration off
//! the deleted `fetch_prs_for_branches` / `resolve_github_remote` shims.
//!
//! Every classified outcome has its own response shape:
//! - `Pr`            → `PrLookupResult::Pr`
//! - `NoPr`          → `PrLookupResult::NoPr`
//! - `NotVisible`    → `PrLookupResult::Error{reason: Api}`
//! - `Auth`          → `PrLookupResult::Error{reason: Auth}`
//! - `Unauthorized`  → `PrLookupResult::NoCredentials`
//! - `Transient`     → `503` (the client retries later)
//! - unsupported host→ `PrLookupResult::Error{reason: Api}` (permanent)
//! - not GitHub      → `PrLookupResult::NotGithub`
//!
//! Credentials are injected, so no test spawns a real `gh`.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::github_auth::{AccountsOutcome, GithubAccount};
use vst_lifecycle::pr_poller::AccountSource;
use vst_proc::tmux::Tmux;
use vst_routes::worktrees::{WorktreeRouteError, WorktreeRoutes};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::worktrees::{PrErrorReason, PrLookupResult};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

fn init_repo_with_remote(path: &Path, remote: &str) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git command {args:?} failed");
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "user.name", "Test User"]);
    std::fs::write(path.join("README.md"), "# Initial Commit\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "Initial commit"]);
    run(&["remote", "add", "origin", remote]);
}

async fn seed_project(store: &StoreHandle, repo_path: &Path, branch: &str) {
    let session = SessionRecord {
        id: "sess-1".into(),
        worktree_id: Some("wt-1".into()),
        project_id: "proj-1".into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: "vst-sess-1".into(),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    };
    let project = ProjectRecord {
        id: "proj-1".into(),
        absolute_path: repo_path.to_string_lossy().to_string(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![WorktreeRecord {
            id: "wt-1".into(),
            name: None,
            branch: branch.into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(1),
            lsp_enabled: None,
            sessions: vec![session],
            open_files: vec![],
        }],
        next_worktree_num: Some(2),
        lsp_enabled: None,
        open_files: vec![],
    };
    store.add_project(project).await.expect("add project");
}

fn account() -> GithubAccount {
    GithubAccount {
        login: "acme".into(),
        token: Some("token-acme".into()),
    }
}

fn accounts(outcome: AccountsOutcome) -> AccountSource {
    Arc::new(move || {
        let outcome = outcome.clone();
        Box::pin(async move { outcome })
    })
}

fn make_routes(
    store: StoreHandle,
    account_source: AccountSource,
    base: impl Into<String>,
) -> WorktreeRoutes {
    WorktreeRoutes::new(
        store,
        Broadcaster::new(16),
        Arc::new(JsonAgentRegistry::new()),
        Tmux::new(),
        4000,
    )
    .with_github_base(base)
    .with_account_source(account_source)
}

async fn mockito_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    mockito::reset();
    guard
}

#[tokio::test]
async fn pr_returns_the_pr_when_visible() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({
                "data": {
                    "a0": {
                        "pullRequests": {
                            "nodes": [{
                                "number": 42,
                                "url": "https://github.com/acme/repo/pull/42",
                                "title": "PR 42",
                                "state": "OPEN",
                                "isDraft": false,
                                "merged": false,
                                "headRepositoryOwner": { "login": "acme" }
                            }]
                        }
                    }
                }
            })
            .to_string(),
        )
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    let result = routes.pr("wt-1").await.expect("ok");
    match result {
        PrLookupResult::Pr { pr } => {
            assert_eq!(pr.number, 42);
            assert_eq!(pr.url, "https://github.com/acme/repo/pull/42");
        }
        other => panic!("expected Pr, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_returns_no_pr_for_an_empty_branch() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"data":{"a0":{"pullRequests":{"nodes":[]}}}}"#)
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    assert_eq!(routes.pr("wt-1").await.expect("ok"), PrLookupResult::NoPr);
}

#[tokio::test]
async fn pr_returns_unsupported_error_for_a_github_enterprise_host() {
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.internal.invalid/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    // No fetch should happen at all — the host is permanently unsupported.
    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        "http://127.0.0.1:1",
    );

    match routes.pr("wt-1").await.expect("ok") {
        PrLookupResult::Error {
            reason, message, ..
        } => {
            assert_eq!(reason, PrErrorReason::Api);
            assert!(message.contains("unsupported"), "{message}");
        }
        other => panic!("expected an Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_returns_not_github_without_a_remote() {
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://gitlab.example.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        "http://127.0.0.1:1",
    );

    assert_eq!(
        routes.pr("wt-1").await.expect("ok"),
        PrLookupResult::NotGithub
    );
}

#[tokio::test]
async fn pr_returns_api_error_when_no_account_can_see_the_repo() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({
                "data": { "a0": null },
                "errors": [{ "type": "NOT_FOUND", "path": ["a0"], "message": "not found" }]
            })
            .to_string(),
        )
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    match routes.pr("wt-1").await.expect("ok") {
        PrLookupResult::Error {
            reason, message, ..
        } => {
            assert_eq!(reason, PrErrorReason::Api);
            assert!(message.contains("not visible"), "{message}");
        }
        other => panic!("expected an Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_returns_auth_error_for_insufficient_scopes() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({
                "data": { "a0": null },
                "errors": [{ "type": "INSUFFICIENT_SCOPES", "path": ["a0"], "message": "needs repo" }]
            })
            .to_string(),
        )
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    match routes.pr("wt-1").await.expect("ok") {
        PrLookupResult::Error {
            reason, message, ..
        } => {
            assert_eq!(reason, PrErrorReason::Auth);
            assert!(message.contains("repo"), "{message}");
        }
        other => panic!("expected an Auth error, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_returns_no_credentials_on_401() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(401)
        .with_body("bad credentials")
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    assert_eq!(
        routes.pr("wt-1").await.expect("ok"),
        PrLookupResult::NoCredentials
    );
}

#[tokio::test]
async fn pr_is_503_on_a_transient_api_failure() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let _mock = mockito::mock("POST", "/graphql")
        .with_status(500)
        .with_body("boom")
        .create();

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Accounts(vec![account()])),
        mockito::server_url(),
    );

    match routes.pr("wt-1").await {
        Err(WorktreeRouteError::ServiceUnavailable(message)) => {
            assert!(message.contains("transient"), "{message}");
        }
        other => panic!("expected ServiceUnavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_is_503_when_gh_times_out() {
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::Transient(
            "`gh auth status` timed out after 5s".into(),
        )),
        "http://127.0.0.1:1",
    );

    match routes.pr("wt-1").await {
        Err(WorktreeRouteError::ServiceUnavailable(message)) => {
            assert!(message.contains("timed out"), "{message}");
        }
        other => panic!("expected ServiceUnavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn pr_returns_no_credentials_when_signed_out() {
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let routes = make_routes(
        store,
        accounts(AccountsOutcome::NoCredentials),
        "http://127.0.0.1:1",
    );

    assert_eq!(
        routes.pr("wt-1").await.expect("ok"),
        PrLookupResult::NoCredentials
    );
}

#[tokio::test]
async fn pr_rechecks_credentials_after_a_cached_signed_out_result() {
    let _guard = mockito_guard().await;
    let dir = tempdir().unwrap();
    let repo = tempdir().unwrap();
    init_repo_with_remote(repo.path(), "https://github.com/acme/repo.git");
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    seed_project(&store, repo.path(), "feat-a").await;

    let graphql = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({ "data": { "a0": { "pullRequests": { "nodes": [] } } } })
                .to_string(),
        )
        .expect(1)
        .create();

    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    let source: AccountSource = Arc::new(move || {
        let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if n == 0 {
                AccountsOutcome::NoCredentials
            } else {
                AccountsOutcome::Accounts(vec![account()])
            }
        })
    });
    let routes = make_routes(store, source, mockito::server_url());

    assert_eq!(
        routes.pr("wt-1").await.expect("ok"),
        PrLookupResult::NoCredentials
    );
    // The user clicks Refresh again after `gh auth login`.
    assert_eq!(routes.pr("wt-1").await.expect("ok"), PrLookupResult::NoPr);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    graphql.assert();
}
