use super::*;
use crate::github_auth::GithubAccount;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).expect("write fake script");
    let mut perms = std::fs::metadata(&path).expect("stat").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).expect("chmod");
    path
}

fn account(login: &str) -> GithubAccount {
    GithubAccount {
        login: login.to_string(),
        token: Some(format!("token-{login}")),
    }
}

fn query(owner: &str, repo: &str, branch: &str) -> Query {
    Query::new(owner, repo, branch)
}

fn key(owner: &str, repo: &str, branch: &str) -> (String, String) {
    query(owner, repo, branch).key()
}

fn pr(number: i64) -> AccountMergedOutcome {
    AccountMergedOutcome::Pr(PrData {
        number,
        url: format!("https://github.com/acme/repo/pull/{number}"),
        title: format!("PR {number}"),
        state: "open".to_string(),
        merged: false,
        draft: false,
    })
}

fn per_account(
    entries: Vec<((String, String), AccountMergedOutcome)>,
) -> HashMap<(String, String), AccountMergedOutcome> {
    entries.into_iter().collect()
}

/// mockito 0.31 serves ONE process-global mock registry, so tests that use
/// it must not run concurrently. Hold this guard for the whole test and
/// clear any mocks left behind by a previous (possibly panicking) test.
///
/// A tokio mutex is used because the guard is legitimately held across
/// awaits (the request under test), which a `std` guard must not be.
async fn mockito_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    mockito::reset();
    guard
}

// ---- query construction -------------------------------------------------

#[test]
fn build_chunk_uses_variables_and_survives_hostile_branches() {
    let hostile = "weird \"branch\" ünïcode";
    let q = query("acme", "repo", hostile);
    let (query_text, variables) = build_chunk(std::slice::from_ref(&q));

    // Variables, not Rust `{:?}` quoting, inside the document.
    assert!(query_text.contains("$o0:String!,$n0:String!,$b0:String!"));
    assert!(query_text.contains("a0: repository(owner: $o0, name: $n0)"));
    assert!(query_text.contains("headRefName: $b0"));
    assert!(
        !query_text.contains("weird"),
        "branch literal leaked into the query text"
    );
    assert!(query_text.contains("orderBy: {field: UPDATED_AT, direction: DESC}"));
    assert!(query_text.contains("headRepositoryOwner { login }"));

    // Round-trip through the wire form reqwest serialises.
    let wire = serde_json::to_string(&json!({
        "query": query_text,
        "variables": variables,
    }))
    .expect("serialise");
    let parsed: serde_json::Value = serde_json::from_str(&wire).expect("valid JSON");
    assert_eq!(parsed["variables"]["b0"], json!(hostile));
    assert_eq!(parsed["variables"]["o0"], json!("acme"));
    assert_eq!(parsed["variables"]["n0"], json!("repo"));
}

#[test]
fn one_hundred_twenty_queries_chunk_into_three() {
    let queries: Vec<Query> = (0..120)
        .map(|i| query("acme", "repo", &format!("branch-{i}")))
        .collect();
    let chunks: Vec<&[Query]> = queries.chunks(MAX_ALIASES_PER_CHUNK).collect();
    assert_eq!(chunks.len(), 3);
    assert_eq!(
        chunks.iter().map(|chunk| chunk.len()).collect::<Vec<_>>(),
        vec![50, 50, 20]
    );
}

// ---- mockito: request shape + classification ---------------------------

#[tokio::test]
async fn one_request_per_chunk_of_fifty() {
    let _guard = mockito_guard().await;
    let mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"data":{}}"#)
        .expect(3)
        .create();

    let accounts = vec![account("acme")];
    let queries: Vec<Query> = (0..120)
        .map(|i| query("acme", "repo", &format!("branch-{i}")))
        .collect();

    let merged = fetch_all(&mockito::server_url(), &accounts, &queries).await;
    assert_eq!(merged.len(), 120);
    mock.assert();
}

#[tokio::test]
async fn aliases_are_keyed_by_repo_and_branch() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": {
            "a0": {
                "pullRequests": {
                    "nodes": [{
                        "number": 7,
                        "url": "https://github.com/acme/repo/pull/7",
                        "title": "PR 7",
                        "state": "OPEN",
                        "isDraft": false,
                        "merged": false,
                        "headRepositoryOwner": { "login": "acme" }
                    }]
                }
            },
            "a1": { "pullRequests": { "nodes": [] } }
        }
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let accounts = vec![account("acme")];
    let queries = vec![
        query("acme", "repo", "main"),
        query("acme", "repo", "feature"),
    ];

    let merged = fetch_all(&mockito::server_url(), &accounts, &queries).await;
    assert_eq!(merged.get(&key("acme", "repo", "main")), Some(&pr(7)));
    assert_eq!(
        merged.get(&key("acme", "repo", "feature")),
        Some(&AccountMergedOutcome::NoPr)
    );
}

#[tokio::test]
async fn fork_pull_request_is_ignored() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": {
            "a0": {
                "pullRequests": {
                    "nodes": [{
                        "number": 9,
                        "url": "https://github.com/someone/repo/pull/9",
                        "title": "Fork",
                        "state": "OPEN",
                        "isDraft": false,
                        "merged": false,
                        "headRepositoryOwner": { "login": "someone-else" }
                    }]
                }
            }
        }
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let accounts = vec![account("acme")];
    let queries = vec![query("acme", "repo", "main")];

    let merged = fetch_all(&mockito::server_url(), &accounts, &queries).await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NoPr)
    );
}

#[tokio::test]
async fn renamed_owner_pr_is_not_treated_as_fork() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": {
            "a0": {
                "owner": { "login": "new" },
                "pullRequests": {
                    "nodes": [{
                        "number": 4,
                        "url": "https://github.com/new/repo/pull/4",
                        "title": "Renamed",
                        "state": "OPEN",
                        "isDraft": false,
                        "merged": false,
                        "headRepositoryOwner": { "login": "new" }
                    }]
                }
            }
        }
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let accounts = vec![account("old")];
    let queries = vec![query("old", "repo", "main")];

    let merged = fetch_all(&mockito::server_url(), &accounts, &queries).await;
    assert!(matches!(
        merged.get(&key("old", "repo", "main")),
        Some(AccountMergedOutcome::Pr(_))
    ));
}

#[tokio::test]
async fn null_alias_with_not_found_is_not_visible_never_no_pr() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": { "a0": null },
        "errors": [{
            "type": "NOT_FOUND",
            "path": ["a0"],
            "message": "Could not resolve to a Repository with the name 'acme/repo'."
        }]
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NotVisible)
    );
}

#[tokio::test]
async fn insufficient_scopes_alias_is_auth() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": { "a0": null },
        "errors": [{
            "type": "INSUFFICIENT_SCOPES",
            "path": ["a0"],
            "message": "Your token has not been granted the required scopes."
        }]
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Auth)
    );
}

#[tokio::test]
async fn chunk_data_null_is_transient() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": null,
        "errors": [{ "type": "RATE_LIMITED", "message": "API rate limit exceeded" }]
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Transient)
    );
}

#[tokio::test]
async fn http_401_is_unauthorized() {
    let _guard = mockito_guard().await;
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(401)
        .with_body(r#"{"message":"Bad credentials"}"#)
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Unauthorized)
    );
}

#[tokio::test]
async fn http_500_is_transient() {
    let _guard = mockito_guard().await;
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(500)
        .with_body("upstream error")
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Transient)
    );
}

#[tokio::test]
async fn http_403_with_saml_body_is_not_visible() {
    let _guard = mockito_guard().await;
    let body = json!({
        "message": "Resource protected by organization SAML enforcement. You must clear your authorization.",
        "documentation_url": "https://docs.github.com"
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(403)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();

    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NotVisible)
    );
}

// ---- deterministic merge (Decision 7) ----------------------------------

#[test]
fn owner_login_account_wins_over_order() {
    let queries = vec![query("alice", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("alice", "repo", "main"),
            AccountMergedOutcome::NoPr,
        )]),
        per_account(vec![(key("alice", "repo", "main"), pr(1))]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(merged.get(&key("alice", "repo", "main")), Some(&pr(1)));
}

#[test]
fn non_null_beats_null() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::NotVisible,
        )]),
        per_account(vec![(key("acme", "repo", "main"), pr(2))]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(merged.get(&key("acme", "repo", "main")), Some(&pr(2)));
}

#[test]
fn no_pr_is_a_visible_outcome() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::NotVisible,
        )]),
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::NoPr,
        )]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NoPr)
    );
}

#[test]
fn all_accounts_401_is_unauthorized() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Unauthorized,
        )]),
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Unauthorized,
        )]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Unauthorized)
    );
}

#[test]
fn no_accounts_is_unauthorized() {
    let queries = vec![query("acme", "repo", "main")];
    let merged = merge_account_results(&queries, &[], &[]);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Unauthorized)
    );
}

#[test]
fn every_account_insufficient_scopes_is_auth() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Auth,
        )]),
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Auth,
        )]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Auth)
    );
}

#[test]
fn mixed_auth_and_not_visible_is_not_visible() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Auth,
        )]),
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::NotVisible,
        )]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NotVisible)
    );
}

#[test]
fn some_transient_and_none_visible_is_transient() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("bob"), account("alice")];
    let per = vec![
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::NotVisible,
        )]),
        per_account(vec![(
            key("acme", "repo", "main"),
            AccountMergedOutcome::Transient,
        )]),
    ];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::Transient)
    );
}

#[test]
fn not_visible_alone_is_never_no_pr() {
    let queries = vec![query("acme", "repo", "main")];
    let accounts = vec![account("acme")];
    let per = vec![per_account(vec![(
        key("acme", "repo", "main"),
        AccountMergedOutcome::NotVisible,
    )])];

    let merged = merge_account_results(&queries, &accounts, &per);
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NotVisible)
    );
}

// ---- remote classification (Decision 9) --------------------------------

fn github(host: &str) -> RemoteClass {
    RemoteClass::Github(GithubRemote {
        host: host.to_string(),
        owner: "acme".to_string(),
        repo: "repo".to_string(),
    })
}

#[test]
fn https_github_com_is_github() {
    assert_eq!(
        classify_remote_with_config("https://github.com/acme/repo.git", None, ""),
        github("github.com")
    );
}

#[test]
fn ssh_github_com_is_github() {
    assert_eq!(
        classify_remote_with_config("git@github.com:acme/repo.git", None, ""),
        github("github.com")
    );
}

#[test]
fn github_enterprise_host_is_unsupported() {
    assert_eq!(
        classify_remote_with_config("https://github.mycorp.com/acme/repo", None, ""),
        RemoteClass::Unsupported {
            host: "github.mycorp.com".to_string()
        }
    );
}

#[test]
fn ssh_alias_to_ssh_github_com_is_github() {
    let config = "Host work\n  HostName ssh.github.com\n";
    assert_eq!(
        classify_remote_with_config("git@work:acme/repo.git", Some(config), ""),
        github("work")
    );
}

#[test]
fn unresolved_github_dash_alias_is_github() {
    assert_eq!(
        classify_remote_with_config("git@github-work:acme/repo.git", None, ""),
        github("github-work")
    );
}

#[test]
fn unresolved_github_com_dash_alias_is_github() {
    assert_eq!(
        classify_remote_with_config("git@github.com-work:acme/repo.git", None, ""),
        github("github.com-work")
    );
}

#[test]
fn ssh_alias_to_non_github_host_is_unsupported() {
    let config = "Host work\n  HostName git.mycorp.com\n";
    assert_eq!(
        classify_remote_with_config("git@work:acme/repo.git", Some(config), ""),
        RemoteClass::Unsupported {
            host: "work".to_string()
        }
    );
}

#[test]
fn non_github_remote_is_not_github() {
    assert_eq!(
        classify_remote_with_config("https://gitlab.com/acme/repo.git", None, ""),
        RemoteClass::NotGithub
    );
    assert_eq!(
        classify_remote_with_config("git@myalias:acme/repo.git", None, ""),
        RemoteClass::NotGithub
    );
    assert_eq!(
        classify_remote_with_config("not a remote url", None, ""),
        RemoteClass::NotGithub
    );
}

// ---- bounded remote exec ----------------------------------------------

#[tokio::test]
async fn get_remote_url_returns_stdout_on_success() {
    let dir = tempfile::tempdir().expect("tempdir");
    let git = write_script(
        dir.path(),
        "git",
        "#!/bin/sh\necho git@github.com:acme/repo.git\n",
    );
    let url = get_remote_url_with(&git, dir.path(), Duration::from_secs(5))
        .await
        .expect("url");
    assert_eq!(url, "git@github.com:acme/repo.git");
}

#[tokio::test]
async fn get_remote_url_times_out_promptly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let git = write_script(dir.path(), "git", "#!/bin/sh\nexec sleep 30\n");

    let started = std::time::Instant::now();
    let result = get_remote_url_with(&git, dir.path(), Duration::from_millis(100)).await;
    assert!(
        matches!(result, Err(GithubError::RemoteProbe(_))),
        "expected a RemoteProbe timeout error, got {result:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "timeout must fire promptly"
    );
}

async fn run_null_a0(errors: Option<serde_json::Value>) -> AccountMergedOutcome {
    let _guard = mockito_guard().await;
    let mut body = json!({ "data": { "a0": null } });
    if let Some(e) = errors {
        body["errors"] = e;
    }
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();
    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[query("acme", "repo", "main")],
    )
    .await;
    merged
        .get(&key("acme", "repo", "main"))
        .cloned()
        .expect("outcome present")
}

#[tokio::test]
async fn null_alias_service_unavailable_is_transient() {
    let out = run_null_a0(Some(json!([{"type":"SERVICE_UNAVAILABLE","path":["a0"]}]))).await;
    assert_eq!(out, AccountMergedOutcome::Transient);
}

#[tokio::test]
async fn null_alias_untyped_error_with_path_is_transient() {
    let out = run_null_a0(Some(
        json!([{"message":"Something went wrong","path":["a0"]}]),
    ))
    .await;
    assert_eq!(out, AccountMergedOutcome::Transient);
}

#[tokio::test]
async fn null_alias_pathless_untyped_error_is_transient() {
    let out = run_null_a0(Some(json!([{"message":"Something went wrong"}]))).await;
    assert_eq!(out, AccountMergedOutcome::Transient);
}

#[tokio::test]
async fn null_alias_forbidden_is_not_visible() {
    let out = run_null_a0(Some(json!([{"type":"FORBIDDEN","path":["a0"]}]))).await;
    assert_eq!(out, AccountMergedOutcome::NotVisible);
}

#[tokio::test]
async fn null_alias_without_errors_is_not_visible() {
    assert_eq!(run_null_a0(None).await, AccountMergedOutcome::NotVisible);
}

#[tokio::test]
async fn not_found_alias_does_not_affect_sibling_alias() {
    let _guard = mockito_guard().await;
    let body = json!({
        "data": { "a0": null, "a1": { "pullRequests": { "nodes": [] } } },
        "errors": [{ "type": "NOT_FOUND", "path": ["a0"], "message": "x" }]
    });
    let _mock = mockito::mock("POST", "/graphql")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body.to_string())
        .create();
    let merged = fetch_all(
        &mockito::server_url(),
        &[account("acme")],
        &[
            query("acme", "repo", "main"),
            query("acme", "other", "main"),
        ],
    )
    .await;
    assert_eq!(
        merged.get(&key("acme", "repo", "main")),
        Some(&AccountMergedOutcome::NotVisible)
    );
    assert!(matches!(
        merged.get(&key("acme", "other", "main")),
        Some(AccountMergedOutcome::Pr(_) | AccountMergedOutcome::NoPr)
    ));
}
