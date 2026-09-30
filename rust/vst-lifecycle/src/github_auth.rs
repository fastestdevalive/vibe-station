//! GitHub credential resolution — ports `services/githubAuth.ts`.
//!
//! Behavior contract:
//! - `gh` CLI is the primary credential source (`gh auth status`).
//! - `GITHUB_TOKEN` / `GH_TOKEN` env vars synthesize a fallback account
//!   when `gh` is absent or has no logins.
//! - `GH_TOKEN_<LOGIN>` env var per login (LOGIN uppercased) overrides.
//! - Never panics; returns `[]` on any failure.

use std::time::Duration;

/// A GitHub account credential resolved from the chain.
#[derive(Clone, Debug, PartialEq)]
pub struct GithubAccount {
    pub login: String,
    pub token: Option<String>,
}

/// Run `gh auth status --hostname github.com` and parse logged-in logins.
///
/// Parses output regardless of exit code — `gh` exits non-zero if any
/// account's token is stale but still prints valid accounts.
/// Returns `[]` on timeout or if `gh` is not on PATH.
async fn gh_logged_in_logins() -> Vec<String> {
    let output = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("gh")
            .args(["auth", "status", "--hostname", "github.com"])
            .output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        _ => return vec![],
    };

    // Combine stdout + stderr for parsing (gh may print warnings on stderr).
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    let mut logins = Vec::new();
    for line in text.lines() {
        if let Some(pos) = line.find("Logged in to github.com account ") {
            let rest = &line[pos + "Logged in to github.com account ".len()..];
            // Parse the login name — regex ([A-Za-z0-9-]+)
            let login: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if !login.is_empty() {
                logins.push(login);
            }
        }
    }
    logins
}

/// Run `gh auth token --user <login> --hostname github.com` and return the token.
///
/// Returns trimmed stdout on exit 0, else `None`.
async fn gh_token_for_user(login: &str) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("gh")
            .args(["auth", "token", "--user", login, "--hostname", "github.com"])
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if output.status.success() {
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    } else {
        None
    }
}

/// Check `GITHUB_TOKEN` then `GH_TOKEN` env vars; returns first non-empty one.
pub fn env_generic_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
        .or_else(|| std::env::var("GH_TOKEN").ok().filter(|t| !t.is_empty()))
}

/// Apply `GH_TOKEN_<LOGIN>` env var override (LOGIN uppercased).
fn apply_per_login_env(acc: &mut GithubAccount) {
    let env_key = format!("GH_TOKEN_{}", acc.login.to_ascii_uppercase());
    if let Ok(token) = std::env::var(&env_key) {
        if !token.is_empty() {
            acc.token = Some(token);
        }
    }
}

/// Get accounts from `gh auth status` + `gh auth token`.
async fn gh_logged_in_accounts() -> Vec<GithubAccount> {
    let logins = gh_logged_in_logins().await;
    let mut accounts = Vec::new();
    for login in logins {
        let token = gh_token_for_user(&login).await;
        accounts.push(GithubAccount { login, token });
    }
    accounts
}

/// Resolve GitHub accounts using the full credential chain.
///
/// 1. `gh auth status` → logins; `gh auth token` → tokens
/// 2. `GH_TOKEN_<LOGIN>` env overrides per account
/// 3. If no gh accounts: `GITHUB_TOKEN`/`GH_TOKEN` synthesizes a fallback
///
/// Returns an empty vec on any failure; never panics.
pub async fn list_accounts() -> Vec<GithubAccount> {
    let mut accounts = gh_logged_in_accounts().await;

    // Per-login env overrides.
    for acc in &mut accounts {
        apply_per_login_env(acc);
    }

    // Synthetic account from generic env token if gh found no logins OR all
    // discovered accounts have no usable token (e.g. locked keyring).
    if accounts.is_empty() || accounts.iter().all(|a| a.token.is_none()) {
        if let Some(tok) = env_generic_token() {
            accounts.push(GithubAccount {
                login: "env:GITHUB_TOKEN".into(),
                token: Some(tok),
            });
        }
    }

    accounts
}
