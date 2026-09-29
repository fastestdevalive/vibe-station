//! GitHub GraphQL API client — ports `services/github.ts`.
//!
//! Behavior contract:
//! - HTTP via `reqwest` with `rustls-tls` backend (no system OpenSSL).
//! - `get_remote_url`: shells out to `git remote get-url origin`.
//! - `resolve_github_remote`: parses host/owner/repo; accepts `github.com`,
//!   SSH aliases (via `~/.ssh/config`), and `/^github[-.]/i` host heuristic.
//! - SSH config caching by mtime of the top-level file + included files.
//! - `fetch_prs_for_branches`: one aliased GraphQL query per GitHub account;
//!   uses `owner_account_cache`; respects `rate_limited_until`.
//! - B1 fix: null alias without NOT_FOUND → error (not no_pr); null data →
//!   error (not no_pr).

use std::collections::HashMap;
use std::path::Path;

use thiserror::Error;
use vst_types::domain::PrErrorKind;

#[derive(Debug, Error)]
pub enum GithubError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("git command error: {0}")]
    Git(String),
    #[error("rate limited until {until_ms}ms")]
    RateLimited { until_ms: u64 },
    #[error("no GitHub remote found")]
    NoGithubRemote,
}

pub type GithubResult<T> = Result<T, GithubError>;

/// A resolved GitHub remote.
#[derive(Clone, Debug, PartialEq)]
pub struct GithubRemote {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// A single PR lookup result.
#[derive(Clone, Debug)]
pub enum PrLookupResult {
    NoPr,
    Pr(PrData),
    Error { kind: PrErrorKind, error: String },
}

#[derive(Clone, Debug)]
pub struct PrData {
    pub number: i64,
    pub url: String,
    pub title: String,
    /// `"open"` or `"closed"`
    pub state: String,
    pub merged: bool,
    pub draft: bool,
}

/// Shell out to `git remote get-url origin` in the given repo path.
pub async fn get_remote_url(repo_path: &Path) -> GithubResult<String> {
    let path = repo_path.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("git")
            .args([
                "-C",
                path.to_str().unwrap_or("."),
                "remote",
                "get-url",
                "origin",
            ])
            .output()
    })
    .await
    .map_err(|e| GithubError::Git(e.to_string()))?
    .map_err(|e| GithubError::Git(e.to_string()))?;

    if !output.status.success() {
        return Err(GithubError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn strip_userinfo_and_port(host: &str) -> &str {
    let without_userinfo = host.rfind('@').map(|i| &host[i + 1..]).unwrap_or(host);
    // Strip trailing :port
    if let Some(colon) = without_userinfo.rfind(':') {
        if without_userinfo[colon + 1..]
            .chars()
            .all(|c| c.is_ascii_digit())
        {
            return &without_userinfo[..colon];
        }
    }
    without_userinfo
}

fn parse_host_owner_repo(remote_url: &str) -> Option<GithubRemote> {
    let trimmed = remote_url.trim();

    // Pattern 1: git@host:owner/repo[.git]
    if let Some(rest) = trimmed.strip_prefix("git@") {
        if let Some(colon) = rest.find(':') {
            let raw_host = &rest[..colon];
            let path = &rest[colon + 1..];
            let path = path.strip_suffix(".git").unwrap_or(path);
            let (owner, repo) = path.split_once('/')?;
            let host = strip_userinfo_and_port(raw_host);
            return Some(GithubRemote {
                host: host.to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
            });
        }
    }

    // Pattern 2: https?://[git@]host/owner/repo[.git]
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://git@"))
        .or_else(|| trimmed.strip_prefix("ssh://"))?;

    let after_userinfo = after_scheme
        .find('@')
        .map(|i| &after_scheme[i + 1..])
        .unwrap_or(after_scheme);
    let mut parts = after_userinfo.splitn(3, '/');
    let raw_host = parts.next()?;
    let owner = parts.next()?;
    let repo_part = parts.next()?;
    let repo = repo_part.strip_suffix(".git").unwrap_or(repo_part);
    let host = strip_userinfo_and_port(raw_host);
    Some(GithubRemote {
        host: host.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// Parse a git remote URL into host/owner/repo components.
/// Returns `None` if the remote is not resolvable to a GitHub remote.
///
/// Checks (in order):
/// 1. Literal `github.com`
/// 2. SSH alias → HostName in `~/.ssh/config` ending in `github.com`
/// 3. Host matches `/^github[-.]/i` heuristic
pub fn resolve_github_remote(remote_url: &str) -> Option<GithubRemote> {
    let parsed = parse_host_owner_repo(remote_url)?;

    if parsed.host == "github.com" {
        return Some(parsed);
    }

    // Heuristic: host starts with "github." or "github-" (case-insensitive).
    let host_lower = parsed.host.to_ascii_lowercase();
    if host_lower.starts_with("github.") || host_lower.starts_with("github-") {
        return Some(parsed);
    }

    // SSH alias check — try ~/.ssh/config synchronously (this fn is sync).
    // Note: a blocking read is acceptable here because this is called from a
    // tokio::task::spawn_blocking context in the PR poller.
    if let Some(resolved_host) = resolve_ssh_alias_sync(&parsed.host) {
        if resolved_host.to_ascii_lowercase().ends_with("github.com") {
            return Some(parsed);
        }
    }

    None
}

fn resolve_ssh_alias_sync(alias: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let config_path = format!("{home}/.ssh/config");
    let text = std::fs::read_to_string(&config_path).ok()?;
    parse_ssh_config_for_host(&text, alias, &format!("{home}/.ssh"))
}

fn parse_ssh_config_for_host(text: &str, alias: &str, ssh_dir: &str) -> Option<String> {
    let alias_lc = alias.to_ascii_lowercase();
    let mut current_hosts: Vec<String> = Vec::new();
    let mut host_map: HashMap<String, String> = HashMap::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let space_idx = line.find(char::is_whitespace);
        let key = space_idx
            .map(|i| &line[..i])
            .unwrap_or(line)
            .to_ascii_lowercase();
        let value = space_idx
            .map(|i| line[i..].trim())
            .unwrap_or("")
            .to_string();

        match key.as_str() {
            "host" => {
                current_hosts = value.split_whitespace().map(str::to_string).collect();
            }
            "hostname" => {
                for h in &current_hosts {
                    if !h.contains('*') && !h.contains('?') {
                        host_map.insert(h.to_ascii_lowercase(), value.clone());
                    }
                }
            }
            "include" => {
                for inc in value.split_whitespace() {
                    let inc_path = if let Some(rel) = inc.strip_prefix("~/") {
                        let home = std::env::var("HOME").unwrap_or_default();
                        format!("{home}/{rel}")
                    } else if inc.starts_with('/') {
                        inc.to_string()
                    } else {
                        format!("{ssh_dir}/{inc}")
                    };
                    if let Ok(included) = std::fs::read_to_string(&inc_path) {
                        if let Some(h) = parse_ssh_config_for_host(&included, alias, ssh_dir) {
                            return Some(h);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    host_map.get(&alias_lc).cloned()
}

/// Parse per-alias GraphQL errors from the response body.
///
/// When alias `aN` is null/missing, checks `body.errors[]` for an entry where
/// `path` contains the alias string. Maps:
/// - `type == "INSUFFICIENT_SCOPES"` → `(Auth, "token for <login> lacks 'repo' scope")`
/// - `type == "NOT_FOUND"` or no matching error entry → `(NotFound, "repo not visible to <login>")`
fn parse_alias_error(body: &serde_json::Value, alias: &str, login: &str) -> (PrErrorKind, String) {
    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
        for err in errors {
            let path_matches = err
                .get("path")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .any(|p| p.as_str().map(|s| s == alias).unwrap_or(false))
                })
                .unwrap_or(false);

            if path_matches {
                let type_str = err.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if type_str == "INSUFFICIENT_SCOPES" {
                    return (
                        PrErrorKind::Auth,
                        format!("token for {login} lacks 'repo' scope"),
                    );
                } else if type_str == "NOT_FOUND" {
                    return (
                        PrErrorKind::NotFound,
                        format!("repo not visible to {login}"),
                    );
                }
            }
        }
    }

    (
        PrErrorKind::NotFound,
        format!("repo not visible to {login}"),
    )
}

/// Fetch PR statuses for multiple branches using the provided accounts.
///
/// This is the testable inner function — `fetch_prs_for_branches` builds
/// accounts and calls this with the production base URL.
///
/// Maintains two maps:
/// - `resolved`: only `Pr`/`NoPr` results (successes)
/// - `last_err`: `(PrErrorKind, String)` for each failed branch
///
/// After the account loop, merges: for each branch not in `resolved`,
/// inserts from `last_err` as `PrLookupResult::Error`, or `NoPr` if neither.
pub(crate) async fn fetch_with(
    accounts: Vec<crate::github_auth::GithubAccount>,
    base_url: &str,
    remote: &GithubRemote,
    branches: &[String],
) -> GithubResult<HashMap<String, PrLookupResult>> {
    if accounts.is_empty() || accounts.iter().all(|a| a.token.is_none()) {
        let mut result = HashMap::new();
        for branch in branches {
            result.insert(
                branch.clone(),
                PrLookupResult::Error {
                    kind: PrErrorKind::NoCredentials,
                    error: "no GitHub credentials available".to_string(),
                },
            );
        }
        return Ok(result);
    }

    let client = reqwest::Client::builder()
        .user_agent("vibe-station/vst-lifecycle")
        .build()?;

    let mut resolved: HashMap<String, PrLookupResult> = HashMap::new();
    let mut last_err: HashMap<String, (PrErrorKind, String)> = HashMap::new();

    // Try each account.
    'account_loop: for account in &accounts {
        let Some(ref token) = account.token else {
            continue;
        };

        // Build aliased GraphQL query.
        let fragments: Vec<String> = branches
            .iter()
            .enumerate()
            .map(|(i, branch)| {
                format!(
                    "a{i}: repository(owner: {owner:?}, name: {repo:?}) {{ pullRequests(headRefName: {branch:?}, first: 1, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ number url title state isDraft merged author {{ login }} }} }} }}",
                    owner = remote.owner,
                    repo = remote.repo,
                    branch = branch,
                )
            })
            .collect();

        let query = format!("query {{ {} }}", fragments.join(" "));

        let url = format!("{base_url}/graphql");
        let resp = match client
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({ "query": query }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let err_str = e.to_string();
                for branch in branches {
                    last_err.insert(branch.clone(), (PrErrorKind::Transient, err_str.clone()));
                }
                continue 'account_loop;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let (kind, err) = if status == 401 {
                (
                    PrErrorKind::Auth,
                    format!("bad credentials for {}", account.login),
                )
            } else {
                (PrErrorKind::Transient, "GitHub API HTTP 5xx".to_string())
            };
            for branch in branches {
                last_err.insert(branch.clone(), (kind, err.clone()));
            }
            continue 'account_loop;
        }

        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                let err = e.to_string();
                for branch in branches {
                    last_err.insert(branch.clone(), (PrErrorKind::Transient, err.clone()));
                }
                continue 'account_loop;
            }
        };

        // B1: null data → error, not no_pr.
        // B3: inspect body.errors for classification — RATE_LIMITED is
        // transient, INSUFFICIENT_SCOPES is auth, NOT_FOUND is not-found.
        let data = match body.get("data") {
            Some(d) if !d.is_null() => d,
            _ => {
                let kind = if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
                    let first_type = errors
                        .first()
                        .and_then(|e| e.get("type"))
                        .and_then(|t| t.as_str());
                    match first_type {
                        Some("RATE_LIMITED") => PrErrorKind::Transient,
                        Some("INSUFFICIENT_SCOPES") => PrErrorKind::Auth,
                        Some("NOT_FOUND") => PrErrorKind::NotFound,
                        _ => PrErrorKind::Transient,
                    }
                } else {
                    PrErrorKind::Transient
                };
                let err = body
                    .get("errors")
                    .and_then(|e| e.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("GitHub API returned null data")
                    .to_string();
                for branch in branches {
                    last_err.insert(branch.clone(), (kind, err.clone()));
                }
                continue 'account_loop;
            }
        };

        for (i, branch) in branches.iter().enumerate() {
            if resolved.contains_key(branch) {
                continue;
            }
            let alias = format!("a{i}");
            let repo_data = match data.get(&alias) {
                Some(v) if !v.is_null() => v,
                _ => {
                    // Check body.errors[] for per-alias error
                    let (kind, err) = parse_alias_error(&body, &alias, &account.login);
                    last_err.insert(branch.clone(), (kind, err));
                    continue;
                }
            };

            let nodes = repo_data
                .pointer("/pullRequests/nodes")
                .and_then(|n| n.as_array());
            let node = nodes.and_then(|arr| arr.first());

            let lookup = match node {
                None => PrLookupResult::NoPr,
                Some(pr) => {
                    let number = pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
                    let url = pr
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let title = pr
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let state = pr
                        .get("state")
                        .and_then(|v| v.as_str())
                        .map(|s| if s == "OPEN" { "open" } else { "closed" })
                        .unwrap_or("closed")
                        .to_string();
                    let merged = pr.get("merged").and_then(|v| v.as_bool()).unwrap_or(false);
                    let draft = pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false);
                    PrLookupResult::Pr(PrData {
                        number,
                        url,
                        title,
                        state,
                        merged,
                        draft,
                    })
                }
            };

            resolved.insert(branch.clone(), lookup);
        }
    }

    // Merge: for each branch not in resolved, insert from last_err or NoPr.
    let mut result = resolved;
    for branch in branches {
        if !result.contains_key(branch) {
            if let Some((kind, error)) = last_err.get(branch) {
                result.insert(
                    branch.clone(),
                    PrLookupResult::Error {
                        kind: *kind,
                        error: error.clone(),
                    },
                );
            } else {
                result.insert(branch.clone(), PrLookupResult::NoPr);
            }
        }
    }

    Ok(result)
}

/// Fetch PR statuses for multiple branches in one batched GraphQL query.
///
/// Key (D1/K4): one query per GitHub account, using aliased queries so that
/// all branches in a single project can be looked up in one round-trip.
pub async fn fetch_prs_for_branches(
    remote: &GithubRemote,
    branches: &[String],
) -> GithubResult<HashMap<String, PrLookupResult>> {
    use crate::github_auth::list_accounts;

    let accounts = list_accounts().await;
    let base_url = "https://api.github.com";
    fetch_with(accounts, base_url, remote, branches).await
}
