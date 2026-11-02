//! GitHub GraphQL API client — ports `services/github.ts`.
//!
//! Behavior contract (poller-redesign plan, Decisions 7–9):
//! - `get_remote_url` is a bounded `tokio::process` exec (5 s timeout,
//!   `kill_on_drop(true)`); never a blocking `std::process`.
//! - `classify_remote` resolves a remote URL to `Github` / `Unsupported` /
//!   `NotGithub`: ssh aliases are resolved via `~/.ssh/config`, a GHE-like
//!   `github.<other-domain>` host is `Unsupported` (never silently treated as
//!   github.com), and an unresolved `github-<acct>` alias keeps today's
//!   "assume github.com" behaviour.
//! - `fetch_all` sends ONE GraphQL request per account per chunk of ≤50
//!   aliases, using GraphQL variables (`$o{i}`, `$n{i}`, `$b{i}`) — never Rust
//!   `{:?}` quoting inside the query text (a branch containing `"` or unicode
//!   must round-trip safely).
//! - Every alias is `repository(owner,name){pullRequests(headRefName:…, first:5,
//!   orderBy:{field:UPDATED_AT,direction:DESC})}`; a node whose
//!   `headRepositoryOwner.login` differs from the repo owner is a fork PR and
//!   is ignored.
//! - Per-account outcomes merge deterministically (`merge_account_results`,
//!   Decision 7): any non-null alias beats null; null / NOT_FOUND / FORBIDDEN /
//!   401 is "not visible", never `NoPr`.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use thiserror::Error;

use crate::github_auth::GithubAccount;

/// Timeout for the local `git remote get-url` exec.
pub const REMOTE_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for one GitHub GraphQL request.
pub const GRAPHQL_TIMEOUT: Duration = Duration::from_secs(20);

/// Maximum number of aliases per GraphQL request (Requirement 2).
pub const MAX_ALIASES_PER_CHUNK: usize = 50;

/// How many PR nodes to fetch per branch before filtering forks.
pub const PR_NODES_PER_BRANCH: usize = 5;

#[derive(Debug, Error)]
pub enum GithubError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("git command error: {0}")]
    Git(String),
    /// The remote probe itself timed out / failed to spawn — transient, not a
    /// statement about the repo (R1F-04).
    #[error("git remote probe failed: {0}")]
    RemoteProbe(String),
    #[error("rate limited until {until_ms}ms")]
    RateLimited { until_ms: u64 },
    #[error("no GitHub remote found")]
    NoGithubRemote,
}

pub type GithubResult<T> = Result<T, GithubError>;

/// A resolved GitHub remote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubRemote {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// How a git remote URL classifies for PR lookup (Decision 9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteClass {
    /// A github.com (or github.com subdomain) remote we can query.
    Github(GithubRemote),
    /// A GitHub-Enterprise-like host (`github.<other-domain>`, or an ssh alias
    /// resolving to a non-github.com host) — permanently unsupported.
    Unsupported { host: String },
    /// Not a GitHub remote at all.
    NotGithub,
    /// The remote could not be probed right now (timeout / spawn error).
    /// Never cached; the poller keeps the last PR value with `stale_since`.
    Transient,
}

/// One `(owner/repo, branch)` PR lookup.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Query {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

impl Query {
    pub fn new(
        owner: impl Into<String>,
        repo: impl Into<String>,
        branch: impl Into<String>,
    ) -> Self {
        Self {
            owner: owner.into(),
            repo: repo.into(),
            branch: branch.into(),
        }
    }

    /// The merge key: `("owner/repo", branch)` — never branch alone.
    pub fn key(&self) -> (String, String) {
        (format!("{}/{}", self.owner, self.repo), self.branch.clone())
    }
}

/// A single PR lookup result.
#[derive(Clone, Debug, PartialEq)]
pub struct PrData {
    pub number: i64,
    pub url: String,
    pub title: String,
    /// `"open"` or `"closed"`
    pub state: String,
    pub merged: bool,
    pub draft: bool,
}

/// Outcome of one account's lookup for one `(repo, branch)`, and — after
/// merging — the deterministic result across every account (Decision 7).
#[derive(Clone, Debug, PartialEq)]
pub enum AccountMergedOutcome {
    Pr(PrData),
    NoPr,
    /// The repo/alias was not visible to this account (null alias, NOT_FOUND,
    /// FORBIDDEN or 401). Never collapsed to `NoPr`.
    NotVisible,
    /// `INSUFFICIENT_SCOPES`: the token lacks the `repo` scope.
    Auth,
    /// Timeout / 5xx / network / rate limit — keep the last-known value.
    Transient,
    /// Every account returned 401.
    Unauthorized,
}

/// Shell out to `git remote get-url origin` in the given repo path, bounded by
/// a timeout and killed on drop.
pub async fn get_remote_url(repo_path: &Path) -> GithubResult<String> {
    get_remote_url_with(Path::new("git"), repo_path, REMOTE_TIMEOUT).await
}

/// Testable `get_remote_url` with an injectable program path and timeout.
pub async fn get_remote_url_with(
    program: &Path,
    repo_path: &Path,
    timeout: Duration,
) -> GithubResult<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args([
        "-C",
        repo_path.to_str().unwrap_or("."),
        "remote",
        "get-url",
        "origin",
    ])
    .kill_on_drop(true);

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| GithubError::RemoteProbe("git remote get-url timed out".to_string()))?
        .map_err(|err| GithubError::RemoteProbe(err.to_string()))?;

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

/// True when `host` is `github.com` or a `*.github.com` subdomain
/// (e.g. `ssh.github.com`). Dot-anchored so `notgithub.com` is not mistaken
/// for GitHub.
fn is_github_host(host_lc: &str) -> bool {
    host_lc == "github.com" || host_lc.ends_with(".github.com")
}

/// Classify a remote URL using the process `~/.ssh/config` for alias lookups.
///
/// This reads files synchronously — call it from `spawn_blocking` in async
/// callers (the poller caches the result per project).
pub fn classify_remote(remote_url: &str) -> RemoteClass {
    let (config, ssh_dir) = read_ssh_config();
    classify_remote_with_config(remote_url, config.as_deref(), &ssh_dir)
}

fn read_ssh_config() -> (Option<String>, String) {
    match std::env::var("HOME") {
        Ok(home) => {
            let ssh_dir = format!("{home}/.ssh");
            let text = std::fs::read_to_string(format!("{ssh_dir}/config")).ok();
            (text, ssh_dir)
        }
        Err(_) => (None, String::new()),
    }
}

/// Pure `classify_remote` with an injected ssh-config text (test seam — no
/// HOME/env mutation).
pub fn classify_remote_with_config(
    remote_url: &str,
    ssh_config: Option<&str>,
    ssh_dir: &str,
) -> RemoteClass {
    let Some(parsed) = parse_host_owner_repo(remote_url) else {
        return RemoteClass::NotGithub;
    };
    let host_lc = parsed.host.to_ascii_lowercase();

    // 1. Literal github.com / *.github.com.
    if is_github_host(&host_lc) {
        return RemoteClass::Github(parsed);
    }

    // 2. SSH alias: resolve to its HostName.
    if let Some(config) = ssh_config {
        if let Some(resolved) = parse_ssh_config_for_host(config, &parsed.host, ssh_dir) {
            if is_github_host(&resolved.to_ascii_lowercase()) {
                return RemoteClass::Github(parsed);
            }
            // An alias that resolves to a non-github.com host is a GHE-like
            // host, not a GitHub remote we can query.
            return RemoteClass::Unsupported { host: parsed.host };
        }
    }

    // 2b. Unresolved `github.com-<acct>` ssh alias (config not visible to our
    // parser, e.g. wildcard `Host` patterns or globbed `Include`) — assume
    // github.com, as the pre-redesign resolver did.
    if host_lc.starts_with("github.com-") {
        return RemoteClass::Github(parsed);
    }

    // 3. `github.<other-domain>` — GHE-like, permanently unsupported.
    if host_lc.starts_with("github.") {
        return RemoteClass::Unsupported { host: parsed.host };
    }

    // 4. Unresolved `github-<acct>` alias — today's "assume github.com".
    if host_lc.starts_with("github-") {
        return RemoteClass::Github(parsed);
    }

    RemoteClass::NotGithub
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

/// Build the GraphQL query text + variables for one chunk of aliases.
///
/// Values travel as GraphQL variables, so the query text contains no user
/// data — a branch with quotes or unicode cannot corrupt the document.
pub fn build_chunk(chunk: &[Query]) -> (String, serde_json::Value) {
    let mut var_decls = Vec::with_capacity(chunk.len() * 3);
    let mut fragments = Vec::with_capacity(chunk.len());
    let mut variables = serde_json::Map::new();

    for (i, query) in chunk.iter().enumerate() {
        var_decls.push(format!("$o{i}:String!"));
        var_decls.push(format!("$n{i}:String!"));
        var_decls.push(format!("$b{i}:String!"));
        fragments.push(format!(
            "a{i}: repository(owner: $o{i}, name: $n{i}) {{ owner {{ login }} pullRequests(headRefName: $b{i}, first: {n}, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ number url title state isDraft merged headRepositoryOwner {{ login }} }} }} }}",
            n = PR_NODES_PER_BRANCH,
        ));
        variables.insert(format!("o{i}"), serde_json::json!(query.owner));
        variables.insert(format!("n{i}"), serde_json::json!(query.repo));
        variables.insert(format!("b{i}"), serde_json::json!(query.branch));
    }

    let query = format!(
        "query({}) {{ {} }}",
        var_decls.join(","),
        fragments.join(" ")
    );
    (query, serde_json::Value::Object(variables))
}

/// Per-chunk HTTP outcome before alias classification.
enum ChunkOutcome {
    /// 401 — the account's token is rejected.
    Unauthorized,
    /// 403 with a SAML/NOT_FOUND/FORBIDDEN body — not visible to this account.
    NotVisible,
    /// 5xx / network / timeout / rate limit.
    Transient,
    /// 2xx body to classify per alias.
    Body(serde_json::Value),
}

async fn post_chunk(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> ChunkOutcome {
    let url = format!("{}/graphql", base_url.trim_end_matches('/'));
    let response = match client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return ChunkOutcome::Transient,
    };

    let status = response.status();
    if status.as_u16() == 401 {
        return ChunkOutcome::Unauthorized;
    }

    let body: serde_json::Value = match response.json().await {
        Ok(body) => body,
        Err(_) => return ChunkOutcome::Transient,
    };

    if !status.is_success() {
        if status.as_u16() == 403 && is_not_visible_403(&body) {
            return ChunkOutcome::NotVisible;
        }
        return ChunkOutcome::Transient;
    }

    ChunkOutcome::Body(body)
}

/// A 403 whose body says SAML enforcement or NOT_FOUND/FORBIDDEN means the
/// resource is simply not visible to this token — not a transient failure.
fn is_not_visible_403(body: &serde_json::Value) -> bool {
    if let Some(message) = body.get("message").and_then(|m| m.as_str()) {
        if message.to_ascii_lowercase().contains("saml") {
            return true;
        }
    }
    body.get("errors")
        .and_then(|e| e.as_array())
        .map(|errors| {
            errors.iter().any(|err| {
                matches!(
                    err.get("type").and_then(|t| t.as_str()),
                    Some("NOT_FOUND" | "FORBIDDEN")
                )
            })
        })
        .unwrap_or(false)
}

fn error_path_matches(err: &serde_json::Value, alias: &str) -> bool {
    err.get("path")
        .and_then(|p| p.as_array())
        .map(|path| {
            path.iter()
                .any(|segment| segment.as_str().is_some_and(|s| s == alias))
        })
        .unwrap_or(false)
}

/// Classify one alias that came back null, using the response's `errors[]`.
///
/// Only a bare null, `NOT_FOUND` or `FORBIDDEN` means "not visible". An error
/// naming the alias with any other (or no) type, or a path-less error of an
/// unknown kind, says nothing about visibility and is `Transient`, so the last
/// known PR value is kept instead of being overwritten with `not_found`.
fn classify_alias_error(body: &serde_json::Value, alias: &str) -> AccountMergedOutcome {
    let Some(errors) = body.get("errors").and_then(|e| e.as_array()) else {
        return AccountMergedOutcome::NotVisible;
    };
    for err in errors {
        if error_path_matches(err, alias) {
            return match err.get("type").and_then(|t| t.as_str()) {
                Some("INSUFFICIENT_SCOPES") => AccountMergedOutcome::Auth,
                Some("NOT_FOUND" | "FORBIDDEN") => AccountMergedOutcome::NotVisible,
                // RATE_LIMITED, SERVICE_UNAVAILABLE, no `type`, ...
                _ => AccountMergedOutcome::Transient,
            };
        }
    }
    let suspect = errors.iter().any(|err| {
        err.get("path")
            .and_then(|p| p.as_array())
            .map_or(true, |p| p.is_empty())
            && !matches!(
                err.get("type").and_then(|t| t.as_str()),
                Some("NOT_FOUND" | "FORBIDDEN")
            )
    });
    if suspect {
        AccountMergedOutcome::Transient
    } else {
        AccountMergedOutcome::NotVisible
    }
}

/// True when the response carries a top-level (path-less) RATE_LIMITED error.
fn has_top_level_rate_limit(body: &serde_json::Value) -> bool {
    body.get("errors")
        .and_then(|e| e.as_array())
        .map(|errors| {
            errors.iter().any(|err| {
                err.get("type").and_then(|t| t.as_str()) == Some("RATE_LIMITED")
                    && err
                        .get("path")
                        .and_then(|p| p.as_array())
                        .map(|path| path.is_empty())
                        .unwrap_or(true)
            })
        })
        .unwrap_or(false)
}

fn parse_pr_node(node: &serde_json::Value) -> PrData {
    let number = node.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
    let url = node
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = node
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = node
        .get("state")
        .and_then(|v| v.as_str())
        .map(|s| if s == "OPEN" { "open" } else { "closed" })
        .unwrap_or("closed")
        .to_string();
    let merged = node
        .get("merged")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let draft = node
        .get("isDraft")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    PrData {
        number,
        url,
        title,
        state,
        merged,
        draft,
    }
}

/// Classify one repository alias value, filtering out fork PRs.
fn classify_repo_value(value: &serde_json::Value, owner: &str) -> AccountMergedOutcome {
    let Some(nodes) = value
        .pointer("/pullRequests/nodes")
        .and_then(|n| n.as_array())
    else {
        return AccountMergedOutcome::NoPr;
    };

    // GraphQL follows renames/transfers, so prefer the repository's own owner
    // over the (possibly stale) owner parsed from the local remote URL.
    let effective_owner = value
        .pointer("/owner/login")
        .and_then(|l| l.as_str())
        .unwrap_or(owner);
    let owner_lc = effective_owner.to_ascii_lowercase();
    for node in nodes {
        let head_owner = node
            .pointer("/headRepositoryOwner/login")
            .and_then(|l| l.as_str());
        let is_fork = match head_owner {
            // Missing owner info: cannot prove it is a fork, so keep it.
            Some(head) => head.to_ascii_lowercase() != owner_lc,
            None => false,
        };
        if is_fork {
            continue;
        }
        return AccountMergedOutcome::Pr(parse_pr_node(node));
    }
    AccountMergedOutcome::NoPr
}

/// Classify a 2xx GraphQL body into one outcome per alias.
fn parse_chunk_body(
    body: &serde_json::Value,
    chunk: &[Query],
) -> HashMap<(String, String), AccountMergedOutcome> {
    let mut outcomes = HashMap::with_capacity(chunk.len());

    // Chunk-level `data: null` is transient (Requirement 3), not "no PR".
    let Some(data) = body.get("data").filter(|d| !d.is_null()) else {
        for query in chunk {
            outcomes.insert(query.key(), AccountMergedOutcome::Transient);
        }
        return outcomes;
    };

    if has_top_level_rate_limit(body) {
        for query in chunk {
            outcomes.insert(query.key(), AccountMergedOutcome::Transient);
        }
        return outcomes;
    }

    for (i, query) in chunk.iter().enumerate() {
        let alias = format!("a{i}");
        let outcome = match data.get(&alias) {
            Some(value) if !value.is_null() => classify_repo_value(value, &query.owner),
            _ => classify_alias_error(body, &alias),
        };
        outcomes.insert(query.key(), outcome);
    }
    outcomes
}

/// Merge per-account outcomes into one deterministic result per key
/// (Decision 7).
///
/// Candidates are ordered owner-login account first, then account order; the
/// first visible outcome (`Pr` or `NoPr`) wins. With no visible outcome:
/// any transient ⇒ `Transient`; all `Auth` ⇒ `Auth`; all `Unauthorized` ⇒
/// `Unauthorized`; otherwise `NotVisible`.
pub fn merge_account_results(
    queries: &[Query],
    accounts: &[GithubAccount],
    per_account: &[HashMap<(String, String), AccountMergedOutcome>],
) -> HashMap<(String, String), AccountMergedOutcome> {
    let mut merged = HashMap::with_capacity(queries.len());

    for query in queries {
        let key = query.key();
        let owner_lc = query.owner.to_ascii_lowercase();

        let mut order: Vec<usize> = (0..accounts.len()).collect();
        order.sort_by_key(|&index| {
            (
                accounts[index].login.to_ascii_lowercase() != owner_lc,
                index,
            )
        });

        let candidates: Vec<&AccountMergedOutcome> = order
            .iter()
            .filter_map(|&index| per_account.get(index).and_then(|map| map.get(&key)))
            .collect();

        merged.insert(key, merge_candidates(&candidates));
    }

    merged
}

fn merge_candidates(candidates: &[&AccountMergedOutcome]) -> AccountMergedOutcome {
    // 1. Any non-null alias (Pr or NoPr) beats null.
    for candidate in candidates {
        match candidate {
            AccountMergedOutcome::Pr(_) | AccountMergedOutcome::NoPr => {
                return (*candidate).clone();
            }
            _ => {}
        }
    }

    if candidates.is_empty() {
        // No account could look (no usable token): treat like an all-401 run.
        return AccountMergedOutcome::Unauthorized;
    }

    // 2. Some transient and nothing visible ⇒ transient (keep last-known value).
    if candidates
        .iter()
        .any(|c| matches!(c, AccountMergedOutcome::Transient))
    {
        return AccountMergedOutcome::Transient;
    }

    // 3. Every non-visible account reported INSUFFICIENT_SCOPES ⇒ Auth.
    if candidates
        .iter()
        .all(|c| matches!(c, AccountMergedOutcome::Auth))
    {
        return AccountMergedOutcome::Auth;
    }

    // 4. Every account 401 ⇒ Unauthorized.
    if candidates
        .iter()
        .all(|c| matches!(c, AccountMergedOutcome::Unauthorized))
    {
        return AccountMergedOutcome::Unauthorized;
    }

    AccountMergedOutcome::NotVisible
}

/// Fetch PR outcomes for every `(owner/repo, branch)` query, across every
/// account (Requirement 2, Decision 7).
///
/// One GraphQL request per account per chunk of ≤50 aliases; accounts without
/// a token contribute no candidates. Never returns an error — failures are
/// classified per key so the poller can keep last-known values.
pub async fn fetch_all(
    base_url: &str,
    accounts: &[GithubAccount],
    queries: &[Query],
) -> HashMap<(String, String), AccountMergedOutcome> {
    if queries.is_empty() {
        return HashMap::new();
    }

    let client = match reqwest::Client::builder()
        .user_agent("vibe-station/vst-lifecycle")
        .timeout(GRAPHQL_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return queries
                .iter()
                .map(|query| (query.key(), AccountMergedOutcome::Transient))
                .collect();
        }
    };

    let mut per_account: Vec<HashMap<(String, String), AccountMergedOutcome>> =
        Vec::with_capacity(accounts.len());

    for account in accounts {
        let mut outcomes = HashMap::with_capacity(queries.len());
        if let Some(token) = account.token.as_deref() {
            for chunk in queries.chunks(MAX_ALIASES_PER_CHUNK) {
                let (query, variables) = build_chunk(chunk);
                let chunk_outcome = post_chunk(&client, base_url, token, &query, variables).await;
                match chunk_outcome {
                    ChunkOutcome::Body(body) => {
                        outcomes.extend(parse_chunk_body(&body, chunk));
                    }
                    ChunkOutcome::Unauthorized => {
                        for q in chunk {
                            outcomes.insert(q.key(), AccountMergedOutcome::Unauthorized);
                        }
                    }
                    ChunkOutcome::NotVisible => {
                        for q in chunk {
                            outcomes.insert(q.key(), AccountMergedOutcome::NotVisible);
                        }
                    }
                    ChunkOutcome::Transient => {
                        for q in chunk {
                            outcomes.insert(q.key(), AccountMergedOutcome::Transient);
                        }
                    }
                }
            }
        }
        per_account.push(outcomes);
    }

    merge_account_results(queries, accounts, &per_account)
}

#[cfg(test)]
mod tests;
