//! Poller tests for `PrPollerHandle` (plan Phase 3.T1).
//!
//! The poller is exercised at its public handle: `run_once()` for a single
//! pass, `start()` for the event-driven driver. Dependencies are injected —
//! account source, remote-classification source and the batched fetch seam —
//! so no test touches a real `gh`, a real remote or the network (except the
//! `mockito` tests, which serve a fake GraphQL endpoint).
//!
//! Clock rule (plan "Test clock rule"): paused-time tests run ONLY against
//! injected fakes and never hit the store's blocking writes, so no real I/O
//! can auto-advance the paused clock. `mockito` tests run unpaused.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast::error::TryRecvError;
use vst_lifecycle::github::{AccountMergedOutcome, GithubRemote, PrData, Query, RemoteClass};
use vst_lifecycle::github_auth::{AccountCache, AccountsOutcome, GithubAccount};
use vst_lifecycle::pr_poller::{AccountSource, Fetcher, Merged, PrPollerHandle, RemoteSource};
use vst_store::StoreHandle;
use vst_types::domain::{
    LifecycleState, PrErrorKind, PrState, PrStatus, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::ProjectRecord;

// ---- fixtures -------------------------------------------------------------

fn pr_status(state: PrState, branch: &str) -> PrStatus {
    PrStatus {
        state,
        number: Some(7),
        url: Some("https://github.com/acme/repo/pull/7".to_string()),
        checked_at: "2026-01-01T00:00:00.000Z".to_string(),
        error: None,
        error_kind: None,
        pr_branch: Some(branch.to_string()),
        stale_since: None,
    }
}

fn session(id: &str, worktree_id: &str, project_id: &str, pr: Option<PrStatus>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: Some(worktree_id.into()),
        project_id: project_id.into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
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
        pr,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

/// One worktree spec: `(branch, session id, existing pr)`.
fn project(id: &str, worktrees: &[(&str, &str, Option<PrStatus>)]) -> ProjectRecord {
    let wts = worktrees
        .iter()
        .map(|(branch, session_id, pr)| {
            let wt_id = format!("{id}-wt-{branch}");
            WorktreeRecord {
                id: wt_id.clone(),
                name: None,
                branch: (*branch).to_string(),
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
                sessions: vec![session(session_id, &wt_id, id, pr.clone())],
                open_files: vec![],
            }
        })
        .collect();
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/tmp/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: wts,
        next_worktree_num: Some(2),
        lsp_enabled: None,
        open_files: vec![],
    }
}

async fn seed_store(projects: Vec<ProjectRecord>) -> (tempfile::TempDir, StoreHandle) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = StoreHandle::open(dir.path().join("test.db")).expect("store");
    for project in projects {
        store.add_project(project).await.expect("add project");
    }
    (dir, store)
}

fn account(login: &str) -> GithubAccount {
    GithubAccount {
        login: login.into(),
        token: Some(format!("token-{login}")),
    }
}

fn accounts_source(accounts: Vec<GithubAccount>) -> AccountSource {
    Arc::new(move || {
        let accounts = accounts.clone();
        Box::pin(async move { AccountsOutcome::Accounts(accounts) })
    })
}

fn github_remote_source() -> RemoteSource {
    Arc::new(|_path: String| {
        Box::pin(async {
            RemoteClass::Github(GithubRemote {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "repo".into(),
            })
        })
    })
}

fn fixed_outcome_fetcher(outcome: AccountMergedOutcome, calls: Arc<AtomicUsize>) -> Fetcher {
    Arc::new(move |queries: Vec<Query>, _accounts: Vec<GithubAccount>| {
        calls.fetch_add(1, Ordering::SeqCst);
        let map: Merged = queries
            .into_iter()
            .map(|query| (query.key(), outcome.clone()))
            .collect();
        Box::pin(async move { map })
    })
}

fn open_pr(number: i64) -> AccountMergedOutcome {
    AccountMergedOutcome::Pr(PrData {
        number,
        url: format!("https://github.com/acme/repo/pull/{number}"),
        title: format!("PR {number}"),
        state: "open".to_string(),
        merged: false,
        draft: false,
    })
}

/// Read the stored PR status of `session_id`.
async fn stored_pr(store: &StoreHandle, project_id: &str, session_id: &str) -> Option<PrStatus> {
    let project = store.get_project(project_id).await.expect("project");
    project
        .worktrees
        .iter()
        .flat_map(|wt| wt.sessions.iter())
        .find(|s| s.id == session_id)
        .and_then(|s| s.pr.clone())
}

/// Drain every `session:updated` broadcast currently queued.
fn drain_pr_updates(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> usize {
    let mut count = 0;
    loop {
        match rx.try_recv() {
            Ok(ServerEvent::SessionUpdated { pr: Some(_), .. }) => count += 1,
            Ok(_) => {}
            Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => return count,
            Err(TryRecvError::Lagged(_)) => {}
        }
    }
}

/// mockito 0.31 serves ONE process-global mock registry, so tests that use it
/// must not run concurrently. Hold this guard for the whole test.
async fn mockito_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    mockito::reset();
    guard
}

/// A GraphQL body answering aliases `a0..a{count-1}` with one PR each.
fn pr_body(count: usize, number: i64) -> serde_json::Value {
    let mut data = serde_json::Map::new();
    for i in 0..count {
        data.insert(
            format!("a{i}"),
            serde_json::json!({
                "pullRequests": {
                    "nodes": [{
                        "number": number,
                        "url": format!("https://github.com/acme/repo/pull/{number}"),
                        "title": format!("PR {number}"),
                        "state": "OPEN",
                        "isDraft": false,
                        "merged": false,
                        "headRepositoryOwner": { "login": "acme" }
                    }]
                }
            }),
        );
    }
    serde_json::json!({ "data": data })
}

// ---- (a) one batched request per account --------------------------------

#[tokio::test]
async fn one_request_per_account_covers_every_branch_across_projects() {
    let _guard = mockito_guard().await;

    let projects = vec![
        project("p1", &[("feat-a", "s1", None), ("feat-b", "s2", None)]),
        project("p2", &[("feat-c", "s3", None), ("feat-d", "s4", None)]),
        project("p3", &[("feat-e", "s5", None), ("feat-f", "s6", None)]),
    ];
    let (_dir, store) = seed_store(projects).await;

    let mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(pr_body(6, 42).to_string())
        .expect(1)
        .create();

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_github_base(mockito::server_url())
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source());

    poller.run_once().await;

    mock.assert();
    for (project_id, session_id) in [
        ("p1", "s1"),
        ("p1", "s2"),
        ("p2", "s3"),
        ("p2", "s4"),
        ("p3", "s5"),
        ("p3", "s6"),
    ] {
        let pr = stored_pr(&store, project_id, session_id)
            .await
            .expect("every main session must get the batched result");
        assert_eq!(pr.state, PrState::Open);
        assert_eq!(pr.number, Some(42));
    }
}

// ---- (b) every account is consulted every run ---------------------------

#[tokio::test]
async fn every_account_is_consulted_on_every_run() {
    let _guard = mockito_guard().await;

    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let mock_a = mockito::mock("POST", "/graphql")
        .match_header("authorization", "Bearer token-acme")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(pr_body(1, 11).to_string())
        .expect(2)
        .create();
    let mock_b = mockito::mock("POST", "/graphql")
        .match_header("authorization", "Bearer token-someone-else")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(pr_body(1, 12).to_string())
        .expect(2)
        .create();

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_github_base(mockito::server_url())
        .with_account_source(accounts_source(vec![
            account("acme"),
            account("someone-else"),
        ]))
        .with_remote_source(github_remote_source());

    poller.run_once().await;
    poller.run_once().await;

    // One request per account per run — 2 runs ⇒ 2 each.
    mock_a.assert();
    mock_b.assert();
}

// ---- (c) transient keeps the last value, sets stale, then clears --------

#[tokio::test]
async fn transient_failure_keeps_last_value_and_marks_stale_then_clears() {
    let _guard = mockito_guard().await;

    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;

    let _failing = mockito::mock("POST", "/graphql")
        .with_status(500)
        .with_body("upstream exploded")
        .create();

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_github_base(mockito::server_url())
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source());

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("value kept");
    assert_eq!(pr.state, PrState::Open, "a transient must never blank a PR");
    assert_eq!(pr.number, Some(7));
    assert!(
        pr.stale_since.is_some(),
        "a transient must mark the value stale"
    );

    // Replace the failing endpoint with a healthy one (mockito 0.31 has no
    // per-mock removal, so reset the process-global registry).
    mockito::reset();
    let _healthy = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(pr_body(1, 7).to_string())
        .create();

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("value kept");
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(
        pr.stale_since, None,
        "a successful run must clear staleness"
    );
}

#[tokio::test]
async fn transient_without_a_prior_value_writes_nothing() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(Arc::new(|| {
            Box::pin(async { AccountsOutcome::Transient("gh timed out".into()) })
        }))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::Transient,
            calls.clone(),
        ));

    poller.run_once().await;

    assert_eq!(stored_pr(&store, "p1", "s1").await, None);
    assert_eq!(drain_pr_updates(&mut rx), 0);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "no fetch when gh is transient"
    );
}

// ---- (d) equality ignores error text (no second broadcast) --------------

#[tokio::test]
async fn repeated_transient_results_do_not_rebroadcast() {
    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::Transient,
            calls.clone(),
        ));

    poller.run_once().await;
    assert_eq!(drain_pr_updates(&mut rx), 1, "going stale broadcasts once");

    // A second transient run produces a different `checked_at` (and would
    // produce different error text with the old comparator) but the value is
    // still "stale": no second broadcast.
    poller.run_once().await;
    assert_eq!(drain_pr_updates(&mut rx), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

// ---- (e) credential outcomes -------------------------------------------

#[tokio::test]
async fn zero_logins_writes_no_credentials() {
    let (_dir, store) = seed_store(vec![
        project("p1", &[("feat-a", "s1", None)]),
        project("p2", &[("feat-b", "s2", None)]),
    ])
    .await;

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(Arc::new(|| {
            Box::pin(async { AccountsOutcome::NoCredentials })
        }))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::NoPr,
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;

    for (project_id, session_id) in [("p1", "s1"), ("p2", "s2")] {
        let pr = stored_pr(&store, project_id, session_id)
            .await
            .expect("no_credentials must be visible");
        assert_eq!(pr.error_kind, Some(PrErrorKind::NoCredentials));
        assert_eq!(pr.state, PrState::None);
    }
}

#[tokio::test]
async fn unauthorized_refreshes_the_token_once_and_never_writes_no_credentials() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let account_calls = Arc::new(AtomicUsize::new(0));
    let account_calls_for_source = account_calls.clone();
    let accounts: AccountSource = Arc::new(move || {
        let call = account_calls_for_source.fetch_add(1, Ordering::SeqCst);
        let login = if call == 0 { "stale" } else { "refreshed" };
        let account = account(login);
        Box::pin(async move { AccountsOutcome::Accounts(vec![account]) })
    });

    let fetch_calls = Arc::new(AtomicUsize::new(0));
    let fetch_calls_for_fetcher = fetch_calls.clone();
    let fetcher: Fetcher = Arc::new(move |queries: Vec<Query>, _accounts: Vec<GithubAccount>| {
        let call = fetch_calls_for_fetcher.fetch_add(1, Ordering::SeqCst);
        let outcome = if call == 0 {
            AccountMergedOutcome::Unauthorized
        } else {
            open_pr(9)
        };
        let map: Merged = queries
            .into_iter()
            .map(|query| (query.key(), outcome.clone()))
            .collect();
        Box::pin(async move { map })
    });

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts)
        .with_remote_source(github_remote_source())
        .with_fetcher(fetcher);

    poller.run_once().await;

    assert_eq!(
        account_calls.load(Ordering::SeqCst),
        2,
        "re-list once after a 401"
    );
    assert_eq!(
        fetch_calls.load(Ordering::SeqCst),
        2,
        "retry once with the fresh token"
    );
    let pr = stored_pr(&store, "p1", "s1").await.expect("PR written");
    assert_eq!(pr.state, PrState::Open);
    assert_ne!(pr.error_kind, Some(PrErrorKind::NoCredentials));
}

#[tokio::test]
async fn all_accounts_401_writes_no_credentials() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::Unauthorized,
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(pr.error_kind, Some(PrErrorKind::NoCredentials));
}

// ---- (f) unsupported host ----------------------------------------------

#[tokio::test]
async fn unsupported_host_writes_unsupported() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(Arc::new(|_path: String| {
            Box::pin(async {
                RemoteClass::Unsupported {
                    host: "github.mycorp.com".into(),
                }
            })
        }))
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::NoPr,
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(pr.error_kind, Some(PrErrorKind::Unsupported));
    assert_eq!(pr.state, PrState::None);
}

#[tokio::test]
async fn unsupported_host_is_written_even_when_signed_out() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(Arc::new(|| {
            Box::pin(async { AccountsOutcome::NoCredentials })
        }))
        .with_remote_source(Arc::new(|_path: String| {
            Box::pin(async {
                RemoteClass::Unsupported {
                    host: "github.mycorp.com".into(),
                }
            })
        }));

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(
        pr.error_kind,
        Some(PrErrorKind::Unsupported),
        "a permanent host state must not be masked by a credential state"
    );
}

#[tokio::test]
async fn non_github_remote_gets_nothing_when_signed_out() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(Arc::new(|| {
            Box::pin(async { AccountsOutcome::NoCredentials })
        }))
        .with_remote_source(Arc::new(|_path: String| {
            Box::pin(async { RemoteClass::NotGithub })
        }));

    poller.run_once().await;

    assert_eq!(
        stored_pr(&store, "p1", "s1").await,
        None,
        "a non-GitHub project has no PR concept to report"
    );
    assert_eq!(drain_pr_updates(&mut rx), 0);
}

#[tokio::test]
async fn not_visible_writes_not_found() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::NotVisible,
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(pr.error_kind, Some(PrErrorKind::NotFound));
}

#[tokio::test]
async fn non_github_remote_writes_nothing() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(Arc::new(|_path: String| {
            Box::pin(async { RemoteClass::NotGithub })
        }))
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::NoPr,
            calls.clone(),
        ));

    poller.run_once().await;

    assert_eq!(stored_pr(&store, "p1", "s1").await, None);
    assert_eq!(drain_pr_updates(&mut rx), 0);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "no query for a non-GitHub remote"
    );
}

// ---- drafting sessions are skipped -------------------------------------

#[tokio::test]
async fn drafting_main_sessions_are_skipped() {
    let mut project = project("p1", &[("feat-a", "s1", None)]);
    project.worktrees[0].sessions[0].lifecycle.state = LifecycleState::Drafting;

    let (_dir, store) = seed_store(vec![project]).await;
    let broadcaster = Broadcaster::new(64);

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::NoPr,
            calls.clone(),
        ));

    poller.run_once().await;

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(stored_pr(&store, "p1", "s1").await, None);
}

// ---- account cache is reused across runs -------------------------------

#[tokio::test]
async fn accounts_are_resolved_once_within_the_ttl() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;

    let account_calls = Arc::new(AtomicUsize::new(0));
    let counter = account_calls.clone();
    let accounts: AccountSource = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        let account = account("acme");
        Box::pin(async move { AccountsOutcome::Accounts(vec![account]) })
    });

    let broadcaster = Broadcaster::new(64);
    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts)
        .with_account_cache(Arc::new(AccountCache::default()))
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            open_pr(1),
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;
    poller.run_once().await;

    assert_eq!(
        account_calls.load(Ordering::SeqCst),
        1,
        "a 10 min TTL means one `gh` resolution across runs"
    );
}

#[tokio::test]
async fn focus_hint_rechecks_a_cached_signed_out_result() {
    let account_calls = Arc::new(AtomicUsize::new(0));
    let build = |calls: Arc<AtomicUsize>, store: StoreHandle| {
        let source: AccountSource = Arc::new(move || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if n == 0 {
                    AccountsOutcome::NoCredentials
                } else {
                    AccountsOutcome::Accounts(vec![account("acme")])
                }
            })
        });
        PrPollerHandle::new(store, Broadcaster::new(64))
            .with_account_source(source)
            .with_account_cache(Arc::new(AccountCache::default()))
            .with_remote_source(github_remote_source())
            .with_fetcher(fixed_outcome_fetcher(
                AccountMergedOutcome::NoPr,
                Arc::new(AtomicUsize::new(0)),
            ))
    };

    // With the hint: the second run re-lists and clears the status.
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let poller = build(account_calls.clone(), store.clone());
    poller.run_once().await;
    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(pr.error_kind, Some(PrErrorKind::NoCredentials));
    poller.hint_worktree();
    poller.run_once().await;
    assert_eq!(account_calls.load(Ordering::SeqCst), 2);
    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_ne!(pr.error_kind, Some(PrErrorKind::NoCredentials));

    // Without the hint: the cached NoCredentials is served.
    let calls = Arc::new(AtomicUsize::new(0));
    let (_dir2, store2) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let poller = build(calls.clone(), store2);
    poller.run_once().await;
    poller.run_once().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

// ---- (g)/(h) driver: burst collapse + spacing (paused clock) ------------

/// Paused-time tests use an injected fetcher that returns no outcomes, so no
/// store write (which would use `spawn_blocking`) can auto-advance the clock.
fn counting_fetcher(calls: Arc<AtomicUsize>) -> Fetcher {
    Arc::new(move |_queries: Vec<Query>, _accounts: Vec<GithubAccount>| {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Merged::new() })
    })
}

/// Yield until the driver has settled (it only ever awaits timers/notifies).
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn trigger_burst_collapses_into_one_run_and_respects_spacing() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = Arc::new(
        PrPollerHandle::new(store.clone(), broadcaster)
            .with_account_source(accounts_source(vec![account("acme")]))
            .with_remote_source(github_remote_source())
            .with_fetcher(counting_fetcher(calls.clone())),
    );
    let handle = poller.clone().start();

    // The first tick fires immediately: one run at t=0.
    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // A burst of 10 focus hints: 1 s debounce, but the 20 s spacing floor from
    // the run at t=0 wins.
    for _ in 0..10 {
        poller.hint_worktree();
    }
    settle().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "debounce holds the run back"
    );

    tokio::time::advance(Duration::from_secs(19)).await;
    settle().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "spacing floor still applies"
    );

    tokio::time::advance(Duration::from_secs(1)).await;
    settle().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "the whole burst collapsed into exactly one run"
    );

    // Nothing else is pending, and the next tick is 45 s away.
    tokio::time::advance(Duration::from_secs(10)).await;
    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn tick_and_mark_collapse_into_one_run_respecting_spacing() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = Arc::new(
        PrPollerHandle::new(store.clone(), broadcaster)
            .with_account_source(accounts_source(vec![account("acme")]))
            .with_remote_source(github_remote_source())
            .with_fetcher(counting_fetcher(calls.clone())),
    );
    let handle = poller.clone().start();

    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // At t=44 s a mark lands; the 45 s tick fires one second later. Both hit
    // the same global key, so the spacing floor (t=20 s) has already passed
    // and exactly ONE run happens at the tick, not two.
    tokio::time::advance(Duration::from_secs(44)).await;
    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    poller.hint_worktree();
    settle().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    settle().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "tick + hint collapse into one run"
    );

    // The next tick is 45 s later (t=90): spacing is satisfied.
    tokio::time::advance(Duration::from_secs(45)).await;
    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    handle.abort();
}

// ---- driver reacts to broadcaster events --------------------------------

#[tokio::test(start_paused = true)]
async fn session_state_idle_event_triggers_a_run() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = Arc::new(
        PrPollerHandle::new(store.clone(), broadcaster.clone())
            .with_account_source(accounts_source(vec![account("acme")]))
            .with_remote_source(github_remote_source())
            .with_fetcher(counting_fetcher(calls.clone())),
    );
    let handle = poller.clone().start();

    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Move past the 20 s spacing floor, then deliver a turn-end event.
    tokio::time::advance(Duration::from_secs(21)).await;
    settle().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    broadcaster.send(ServerEvent::SessionState {
        session_id: "s1".into(),
        state: LifecycleState::Idle,
        reason: None,
    });
    settle().await;
    tokio::time::advance(Duration::from_secs(2)).await;
    settle().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "a session:state idle event marks the key dirty"
    );

    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn project_deleted_drops_the_cached_remote_class() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let broadcaster = Broadcaster::new(64);

    let remote_calls = Arc::new(AtomicUsize::new(0));
    let counter = remote_calls.clone();
    let remote: RemoteSource = Arc::new(move |_path: String| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            RemoteClass::Github(GithubRemote {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "repo".into(),
            })
        })
    });

    let calls = Arc::new(AtomicUsize::new(0));
    let poller = Arc::new(
        PrPollerHandle::new(store.clone(), broadcaster.clone())
            .with_account_source(accounts_source(vec![account("acme")]))
            .with_remote_source(remote)
            .with_fetcher(counting_fetcher(calls.clone())),
    );
    let handle = poller.clone().start();

    settle().await;
    assert_eq!(
        remote_calls.load(Ordering::SeqCst),
        1,
        "classified once, cached"
    );

    tokio::time::advance(Duration::from_secs(21)).await;
    settle().await;
    assert_eq!(
        remote_calls.load(Ordering::SeqCst),
        1,
        "second run reuses the cache"
    );

    broadcaster.send(ServerEvent::ProjectDeleted {
        project_id: "p1".into(),
    });
    settle().await;

    // The deletion drops the cached classification; the next tick (t=45)
    // re-derives it.
    tokio::time::advance(Duration::from_secs(24)).await;
    settle().await;
    assert_eq!(
        remote_calls.load(Ordering::SeqCst),
        2,
        "cache dropped ⇒ re-derive"
    );

    handle.abort();
}

// ---- R1F-02/03/04: per-account 401 retry, bounded fetch, transient remote ----

use std::collections::HashMap;
use std::sync::Mutex;

/// Remote source mapping `/tmp/<project>` → `acme/r<N>` so two projects hit
/// different repos (`p1` → `r1`, `p2` → `r2`).
fn per_project_remote_source() -> RemoteSource {
    Arc::new(|path: String| {
        let repo = match path.as_str() {
            "/tmp/p1" => "r1",
            "/tmp/p2" => "r2",
            _ => "repo",
        };
        let repo = repo.to_string();
        Box::pin(async move {
            RemoteClass::Github(GithubRemote {
                host: "github.com".into(),
                owner: "acme".into(),
                repo,
            })
        })
    })
}

fn account_with_token(login: &str, token: &str) -> GithubAccount {
    GithubAccount {
        login: login.into(),
        token: Some(token.into()),
    }
}

/// Account source: call 0 returns `first`, every later call `later`.
fn scripted_account_source(
    first: Vec<GithubAccount>,
    later: AccountsOutcome,
    calls: Arc<AtomicUsize>,
) -> AccountSource {
    Arc::new(move || {
        let call = calls.fetch_add(1, Ordering::SeqCst);
        let outcome = if call == 0 {
            AccountsOutcome::Accounts(first.clone())
        } else {
            later.clone()
        };
        Box::pin(async move { outcome })
    })
}

/// Fetcher keyed on the single account it is handed: `(login, token)` →
/// outcome for every query. Counts calls per login.
fn keyed_fetcher(
    answer: impl Fn(&GithubAccount, &Query) -> AccountMergedOutcome + Send + Sync + 'static,
    per_login: Arc<Mutex<HashMap<String, usize>>>,
) -> Fetcher {
    let answer = Arc::new(answer);
    Arc::new(move |queries: Vec<Query>, accounts: Vec<GithubAccount>| {
        assert_eq!(accounts.len(), 1, "the poller fetches one account per call");
        let account = accounts[0].clone();
        *per_login
            .lock()
            .expect("lock")
            .entry(account.login.clone())
            .or_insert(0) += 1;
        let map: Merged = queries
            .iter()
            .map(|query| (query.key(), answer(&account, query)))
            .collect();
        Box::pin(async move { map })
    })
}

fn count_for(map: &Arc<Mutex<HashMap<String, usize>>>, login: &str) -> usize {
    map.lock().expect("lock").get(login).copied().unwrap_or(0)
}

#[tokio::test]
async fn partial_401_refreshes_and_retries_only_the_rejected_account() {
    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;
    let account_calls = Arc::new(AtomicUsize::new(0));
    let source = scripted_account_source(
        vec![
            account_with_token("a", "old"),
            account_with_token("b", "tb"),
        ],
        AccountsOutcome::Accounts(vec![
            account_with_token("a", "new"),
            account_with_token("b", "tb"),
        ]),
        account_calls.clone(),
    );
    let counts = Arc::new(Mutex::new(HashMap::new()));
    let fetcher = keyed_fetcher(
        |account, _q| match (account.login.as_str(), account.token.as_deref()) {
            ("a", Some("old")) => AccountMergedOutcome::Unauthorized,
            ("a", _) => open_pr(9),
            _ => AccountMergedOutcome::NotVisible,
        },
        counts.clone(),
    );
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(source)
        .with_remote_source(github_remote_source())
        .with_fetcher(fetcher);

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("pr");
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.number, Some(9));
    assert_eq!(pr.error_kind, None);
    assert_eq!(account_calls.load(Ordering::SeqCst), 2);
    assert_eq!(count_for(&counts, "a"), 2);
    assert_eq!(
        count_for(&counts, "b"),
        1,
        "the healthy account is not re-queried"
    );
}

#[tokio::test]
async fn partial_401_still_rejected_is_not_found_never_no_credentials() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let source = scripted_account_source(
        vec![
            account_with_token("a", "old"),
            account_with_token("b", "tb"),
        ],
        AccountsOutcome::Accounts(vec![
            account_with_token("a", "new"),
            account_with_token("b", "tb"),
        ]),
        Arc::new(AtomicUsize::new(0)),
    );
    let fetcher = keyed_fetcher(
        |account, _q| {
            if account.login == "a" {
                AccountMergedOutcome::Unauthorized
            } else {
                AccountMergedOutcome::NotVisible
            }
        },
        Arc::new(Mutex::new(HashMap::new())),
    );
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(source)
        .with_remote_source(github_remote_source())
        .with_fetcher(fetcher);

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("pr");
    assert_eq!(pr.error_kind, Some(PrErrorKind::NotFound));
}

#[tokio::test]
async fn refreshed_account_with_the_same_token_is_not_requeried() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let accounts = vec![account_with_token("a", "t"), account_with_token("b", "tb")];
    let account_calls = Arc::new(AtomicUsize::new(0));
    let source = scripted_account_source(
        accounts.clone(),
        AccountsOutcome::Accounts(accounts),
        account_calls.clone(),
    );
    let counts = Arc::new(Mutex::new(HashMap::new()));
    let fetcher = keyed_fetcher(
        |account, _q| {
            if account.login == "a" {
                AccountMergedOutcome::Unauthorized
            } else {
                AccountMergedOutcome::NotVisible
            }
        },
        counts.clone(),
    );
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(source)
        .with_remote_source(github_remote_source())
        .with_fetcher(fetcher);

    poller.run_once().await;

    assert_eq!(account_calls.load(Ordering::SeqCst), 2);
    assert_eq!(count_for(&counts, "a"), 1, "same token would 401 again");
    assert_eq!(count_for(&counts, "b"), 1);
}

#[tokio::test]
async fn permanent_401_relists_at_most_once_within_the_cooldown() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let account_calls = Arc::new(AtomicUsize::new(0));
    let acct = vec![account_with_token("acme", "t")];
    let source = scripted_account_source(
        acct.clone(),
        AccountsOutcome::Accounts(acct),
        account_calls.clone(),
    );
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(source)
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            AccountMergedOutcome::Unauthorized,
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;
    poller.run_once().await;

    assert_eq!(account_calls.load(Ordering::SeqCst), 2);
    let pr = stored_pr(&store, "p1", "s1").await.expect("pr");
    assert_eq!(pr.error_kind, Some(PrErrorKind::NoCredentials));
}

#[tokio::test]
async fn refresh_transient_keeps_good_results_and_stales_the_rest() {
    let (_dir, store) = seed_store(vec![
        project("p1", &[("feat-a", "s1", None)]),
        project(
            "p2",
            &[("feat-b", "s2", Some(pr_status(PrState::Open, "feat-b")))],
        ),
    ])
    .await;
    let source = scripted_account_source(
        vec![account_with_token("a", "ta"), account_with_token("b", "tb")],
        AccountsOutcome::Transient("gh timed out".into()),
        Arc::new(AtomicUsize::new(0)),
    );
    let fetcher = keyed_fetcher(
        |account, query| {
            if account.login == "a" {
                AccountMergedOutcome::Unauthorized
            } else if query.repo == "r1" {
                open_pr(9)
            } else {
                AccountMergedOutcome::NotVisible
            }
        },
        Arc::new(Mutex::new(HashMap::new())),
    );
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(source)
        .with_remote_source(per_project_remote_source())
        .with_fetcher(fetcher);

    poller.run_once().await;

    let fresh = stored_pr(&store, "p1", "s1").await.expect("fresh");
    assert_eq!(fresh.number, Some(9));
    assert_eq!(fresh.stale_since, None);
    let kept = stored_pr(&store, "p2", "s2").await.expect("kept");
    assert_eq!(kept.state, PrState::Open);
    assert!(kept.stale_since.is_some());
    assert_ne!(kept.error_kind, Some(PrErrorKind::NoCredentials));
}

/// `slow` sleeps far past the fetch budget; `fast` answers at once (r1 → PR,
/// r2 → not visible).
fn slow_fast_fetcher() -> Fetcher {
    Arc::new(move |queries: Vec<Query>, accounts: Vec<GithubAccount>| {
        let login = accounts[0].login.clone();
        Box::pin(async move {
            if login == "slow" {
                tokio::time::sleep(Duration::from_secs(300)).await;
            }
            queries
                .into_iter()
                .map(|query| {
                    let outcome = if login == "fast" && query.repo == "r2" {
                        AccountMergedOutcome::NotVisible
                    } else {
                        open_pr(9)
                    };
                    (query.key(), outcome)
                })
                .collect::<Merged>()
        })
    })
}

#[tokio::test(start_paused = true)]
async fn hung_account_is_cut_off_without_starving_the_healthy_one() {
    let (_dir, store) = seed_store(vec![
        project("p1", &[("feat-a", "s1", None)]),
        project(
            "p2",
            &[("feat-b", "s2", Some(pr_status(PrState::Open, "feat-b")))],
        ),
    ])
    .await;
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts_source(vec![account("slow"), account("fast")]))
        .with_remote_source(per_project_remote_source())
        .with_fetcher(slow_fast_fetcher());

    poller.run_once().await;

    let fresh = stored_pr(&store, "p1", "s1")
        .await
        .expect("fast answer written");
    assert_eq!(fresh.number, Some(9));
    assert_eq!(fresh.stale_since, None);
    let kept = stored_pr(&store, "p2", "s2").await.expect("kept");
    assert_eq!(kept.state, PrState::Open);
    assert_eq!(kept.number, Some(7));
    assert!(kept.stale_since.is_some());
    assert_ne!(kept.checked_at, "2026-01-01T00:00:00.000Z");
}

#[tokio::test(start_paused = true)]
async fn only_a_hung_account_keeps_the_value_stale_not_no_credentials() {
    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts_source(vec![account("slow")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(slow_fast_fetcher());

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("kept");
    assert!(pr.stale_since.is_some());
    assert_ne!(pr.error_kind, Some(PrErrorKind::NoCredentials));
    assert_eq!(pr.state, PrState::Open);
}

#[tokio::test(start_paused = true)]
async fn only_a_hung_account_without_a_prior_value_writes_nothing() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts_source(vec![account("slow")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(slow_fast_fetcher());

    poller.run_once().await;

    assert!(stored_pr(&store, "p1", "s1").await.is_none());
}

#[tokio::test]
async fn transient_remote_probe_is_not_cached_and_keeps_the_value_stale() {
    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;
    let remote_calls = Arc::new(AtomicUsize::new(0));
    let calls = remote_calls.clone();
    let remote: RemoteSource = Arc::new(move |_path: String| {
        let call = calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 0 {
                RemoteClass::Transient
            } else {
                RemoteClass::Github(GithubRemote {
                    host: "github.com".into(),
                    owner: "acme".into(),
                    repo: "repo".into(),
                })
            }
        })
    });
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(remote)
        .with_fetcher(fixed_outcome_fetcher(
            open_pr(7),
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;
    let pr = stored_pr(&store, "p1", "s1").await.expect("kept");
    assert!(
        pr.stale_since.is_some(),
        "transient probe marks the value stale"
    );
    assert_eq!(pr.state, PrState::Open);

    poller.run_once().await;
    assert_eq!(
        remote_calls.load(Ordering::SeqCst),
        2,
        "Transient is never cached"
    );
    let pr = stored_pr(&store, "p1", "s1").await.expect("pr");
    assert_eq!(pr.stale_since, None);
}

#[tokio::test(start_paused = true)]
async fn fetch_budget_covers_slow_remote_probes_and_still_marks_stale() {
    let (_dir, store) = seed_store(vec![project(
        "p1",
        &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
    )])
    .await;
    let slow_remote: RemoteSource = Arc::new(|_path: String| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(20)).await;
            RemoteClass::Github(GithubRemote {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "repo".into(),
            })
        })
    });
    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts_source(vec![account("slow")]))
        .with_remote_source(slow_remote)
        .with_fetcher(slow_fast_fetcher());

    let start = tokio::time::Instant::now();
    poller.run_once().await;
    let elapsed = start.elapsed();

    let pr = stored_pr(&store, "p1", "s1").await.expect("kept");
    assert!(pr.stale_since.is_some());
    assert!(elapsed <= Duration::from_secs(51), "elapsed {elapsed:?}");
}

#[tokio::test(start_paused = true)]
async fn transient_credentials_keep_last_pr_value_and_set_stale_since() {
    let existing_pr = pr_status(PrState::Open, "feat-a");
    let (_dir, store) =
        seed_store(vec![project("p1", &[("feat-a", "s1", Some(existing_pr))])]).await;

    let accounts: AccountSource = Arc::new(|| {
        Box::pin(async { AccountsOutcome::Transient("gh auth token failed for alice".into()) })
    });

    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts)
        .with_remote_source(github_remote_source())
        .with_fetcher(fixed_outcome_fetcher(
            open_pr(1),
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;

    let pr = stored_pr(&store, "p1", "s1").await.expect("written");
    assert_eq!(
        pr.state,
        PrState::Open,
        "must keep last PR value, never write no_credentials"
    );
    assert!(pr.error_kind.is_none());
    assert!(
        pr.stale_since.is_some(),
        "must set stale_since on transient failure"
    );
}

#[tokio::test(start_paused = true)]
async fn paused_time_ages_account_ttl_and_remote_cache() {
    let (_dir, store) = seed_store(vec![project("p1", &[("feat-a", "s1", None)])]).await;
    let account_calls = Arc::new(AtomicUsize::new(0));
    let ac = account_calls.clone();
    let accounts: AccountSource = Arc::new(move || {
        ac.fetch_add(1, Ordering::SeqCst);
        let account = account("acme");
        Box::pin(async move { AccountsOutcome::Accounts(vec![account]) })
    });
    let remote_calls = Arc::new(AtomicUsize::new(0));
    let rc = remote_calls.clone();
    let remote_src: RemoteSource = Arc::new(move |_path| {
        rc.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            RemoteClass::Github(GithubRemote {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "repo".into(),
            })
        })
    });

    let poller = PrPollerHandle::new(store.clone(), Broadcaster::new(64))
        .with_account_source(accounts)
        .with_account_cache(Arc::new(AccountCache::default()))
        .with_remote_source(remote_src)
        .with_fetcher(fixed_outcome_fetcher(
            open_pr(1),
            Arc::new(AtomicUsize::new(0)),
        ));

    poller.run_once().await;
    assert_eq!(account_calls.load(Ordering::SeqCst), 1);
    assert_eq!(remote_calls.load(Ordering::SeqCst), 1);

    // Run again immediately: both caches hit
    poller.run_once().await;
    assert_eq!(account_calls.load(Ordering::SeqCst), 1);
    assert_eq!(remote_calls.load(Ordering::SeqCst), 1);

    // Advance paused time past 10 minutes (601 seconds)
    tokio::time::advance(Duration::from_secs(601)).await;

    // Both caches have expired and are re-queried
    poller.run_once().await;
    assert_eq!(account_calls.load(Ordering::SeqCst), 2);
    assert_eq!(remote_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn timeout_during_fetch_applies_stale_since_and_broadcasts_once() {
    let (_dir, store) = seed_store(vec![
        project(
            "p1",
            &[("feat-a", "s1", Some(pr_status(PrState::Open, "feat-a")))],
        ),
        project(
            "p2",
            &[("feat-b", "s2", Some(pr_status(PrState::Open, "feat-b")))],
        ),
    ])
    .await;

    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    // Fetcher hangs past fetch budget
    let hanging_fetcher: Fetcher = Arc::new(|_queries, _accounts| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(120)).await;
            HashMap::new()
        })
    });

    let poller = PrPollerHandle::new(store.clone(), broadcaster)
        .with_account_source(accounts_source(vec![account("acme")]))
        .with_remote_source(github_remote_source())
        .with_fetcher(hanging_fetcher);

    let start = tokio::time::Instant::now();
    poller.run_once().await;
    let elapsed = start.elapsed();
    assert!(
        elapsed <= Duration::from_secs(51),
        "fetch phase must cut off at budget, took {elapsed:?}"
    );

    // Both sessions had existing PRs and should now have stale_since set
    let pr1 = stored_pr(&store, "p1", "s1").await.expect("p1");
    assert!(pr1.stale_since.is_some(), "p1 must be marked stale");
    assert_eq!(pr1.state, PrState::Open);

    let pr2 = stored_pr(&store, "p2", "s2").await.expect("p2");
    assert!(pr2.stale_since.is_some(), "p2 must be marked stale");
    assert_eq!(pr2.state, PrState::Open);

    // Broadcasts should have been received for both sessions
    let mut broadcasted_sessions = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let ServerEvent::SessionUpdated {
            session_id,
            pr: Some(pr),
            ..
        } = event
        {
            assert!(pr.stale_since.is_some());
            broadcasted_sessions.push(session_id);
        }
    }
    assert_eq!(broadcasted_sessions.len(), 2);
    assert!(broadcasted_sessions.contains(&"s1".to_string()));
    assert!(broadcasted_sessions.contains(&"s2".to_string()));
}
