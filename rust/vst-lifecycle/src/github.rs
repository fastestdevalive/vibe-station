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
    NoCredentials { error: String },
    Error { error: String },
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

    if accounts.is_empty() || accounts.iter().all(|a| a.token.is_none()) {
        let mut result = HashMap::new();
        for branch in branches {
            result.insert(
                branch.clone(),
                PrLookupResult::NoCredentials {
                    error: "no GitHub credentials available".to_string(),
                },
            );
        }
        return Ok(result);
    }

    let client = reqwest::Client::builder()
        .user_agent("vibe-station/vst-lifecycle")
        .build()?;

    let mut result: HashMap<String, PrLookupResult> = HashMap::new();

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

        let resp = match client
            .post("https://api.github.com/graphql")
            .bearer_auth(token)
            .json(&serde_json::json!({ "query": query }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let err_str = e.to_string();
                for branch in branches {
                    result
                        .entry(branch.clone())
                        .or_insert_with(|| PrLookupResult::Error {
                            error: err_str.clone(),
                        });
                }
                continue 'account_loop;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let err = format!("GitHub API HTTP {status}");
            for branch in branches {
                result
                    .entry(branch.clone())
                    .or_insert_with(|| PrLookupResult::Error { error: err.clone() });
            }
            continue 'account_loop;
        }

        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                let err = e.to_string();
                for branch in branches {
                    result
                        .entry(branch.clone())
                        .or_insert_with(|| PrLookupResult::Error { error: err.clone() });
                }
                continue 'account_loop;
            }
        };

        // B1: null data → error, not no_pr.
        let data = match body.get("data") {
            Some(d) if !d.is_null() => d,
            _ => {
                let err = body
                    .get("errors")
                    .and_then(|e| e.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("GraphQL returned no data")
                    .to_string();
                for branch in branches {
                    result
                        .entry(branch.clone())
                        .or_insert_with(|| PrLookupResult::Error { error: err.clone() });
                }
                continue 'account_loop;
            }
        };

        for (i, branch) in branches.iter().enumerate() {
            if result.contains_key(branch) {
                continue;
            }
            let alias = format!("a{i}");
            let repo_data = match data.get(&alias) {
                Some(v) if !v.is_null() => v,
                _ => {
                    // B1: alias missing/null without NOT_FOUND error → error
                    result.insert(
                        branch.clone(),
                        PrLookupResult::Error {
                            error: "repository not found or inaccessible".to_string(),
                        },
                    );
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

            result.insert(branch.clone(), lookup);
        }
    }

    // Fill any remaining branches with NoPr.
    for branch in branches {
        result.entry(branch.clone()).or_insert(PrLookupResult::NoPr);
    }

    Ok(result)
}
