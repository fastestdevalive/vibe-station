//! GitHub credential resolution — ports `services/githubAuth.ts`.
//!
//! Behavior contract (D2/D3 — see TS source header):
//! - Never requires the `gh` binary (not provisioned in CI).
//! - Credential chain (D3):
//!   1. `GH_TOKEN_<LOGIN>` env var per login (LOGIN uppercased)
//!   2. `GITHUB_TOKEN` / `GH_TOKEN` generic env vars — fills logins with no
//!      token only when there is exactly one known login (step 2b: a generic
//!      token only fills logins with no token AFTER step 4, but only if there
//!      is no ambiguity — applies to the single-account case)
//!   3. `~/.config/gh/hosts.yml` (or `$GH_CONFIG_DIR/hosts.yml`)
//!   4. `gh auth token --user X` only if `gh` happens to be on PATH
//! - Never panics; returns `[]` on any failure.

use std::process::Command;

/// A GitHub account credential resolved from the chain.
#[derive(Clone, Debug, PartialEq)]
pub struct GithubAccount {
    pub login: String,
    pub token: Option<String>,
}

/// Parse a `~/.config/gh/hosts.yml`-shaped file for `github.com` credentials.
///
/// Only the `github.com:` block is processed; any GHES blocks are excluded.
/// A login with no plaintext `oauth_token` (e.g. keyring-backed) returns
/// `token: None`.
pub fn parse_hosts_yml(text: &str) -> Vec<GithubAccount> {
    let mut result = Vec::new();
    let mut in_github_com = false;
    let mut in_users = false;
    let mut current_login: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim_end();

        // Top-level host key (zero-indent, ends with ':')
        if !trimmed.starts_with(' ') && !trimmed.starts_with('\t') {
            let key = trimmed.trim_end_matches(':');
            in_github_com = key == "github.com";
            in_users = false;
            current_login = None;
            continue;
        }

        if !in_github_com {
            continue;
        }

        let stripped = trimmed.trim_start();
        let indent = trimmed.len() - stripped.len();

        // `    users:` — 4-space indent
        if stripped == "users:" {
            in_users = true;
            current_login = None;
            continue;
        }

        if !in_users {
            continue;
        }

        // login lines are at 8-space indent.
        // Formats: `alice:`, `keyring-user: {}`, `commented-login: # comment`
        if indent == 8 && stripped.contains(':') {
            let colon_pos = stripped.find(':').unwrap();
            let login_candidate = stripped[..colon_pos].trim();
            if !login_candidate.is_empty() && !login_candidate.contains(' ') {
                current_login = Some(login_candidate.to_string());
                result.push(GithubAccount {
                    login: login_candidate.to_string(),
                    token: None,
                });
            }
            continue;
        }

        // `oauth_token: <value>` lines are at 12-space indent
        if indent == 12 && stripped.starts_with("oauth_token:") {
            if let Some(ref login) = current_login {
                let token_val = stripped["oauth_token:".len()..].trim();
                if !token_val.is_empty() {
                    if let Some(entry) = result.iter_mut().find(|a| &a.login == login) {
                        entry.token = Some(token_val.to_string());
                    }
                }
            }
        }
    }

    result
}

fn gh_config_dir() -> Option<std::path::PathBuf> {
    if let Some(d) = std::env::var_os("GH_CONFIG_DIR") {
        return Some(std::path::PathBuf::from(d));
    }
    // Default: ~/.config/gh — use HOME env var (POSIX standard, always set on Linux).
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config").join("gh"))
}

/// Resolve GitHub accounts using the full credential chain.
/// Returns an empty vec on any failure; never panics.
pub async fn list_accounts() -> Vec<GithubAccount> {
    // Step 3: parse hosts.yml to get the known logins.
    let mut accounts: Vec<GithubAccount> = {
        let config_dir = gh_config_dir();
        let hosts_path = config_dir.map(|d| d.join("hosts.yml"));
        if let Some(path) = hosts_path {
            if let Ok(text) = tokio::fs::read_to_string(&path).await {
                parse_hosts_yml(&text)
            } else {
                vec![]
            }
        } else {
            vec![]
        }
    };

    // Step 4: try `gh auth token --user <login>` for logins still missing tokens.
    for acc in accounts.iter_mut() {
        if acc.token.is_some() {
            continue;
        }
        if let Ok(output) = Command::new("gh")
            .args(["auth", "token", "--user", &acc.login])
            .output()
        {
            if output.status.success() {
                let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !token.is_empty() {
                    acc.token = Some(token);
                }
            }
        }
    }

    // Step 1: per-login env var overrides (GH_TOKEN_<LOGIN>, uppercased).
    for acc in accounts.iter_mut() {
        let env_key = format!("GH_TOKEN_{}", acc.login.to_ascii_uppercase());
        if let Ok(token) = std::env::var(&env_key) {
            if !token.is_empty() {
                acc.token = Some(token);
            }
        }
    }

    // Step 2b: generic GITHUB_TOKEN / GH_TOKEN fills only logins that still
    // have no token, but only when there's exactly ONE known login (no
    // ambiguity across accounts — a generic token for the wrong account would
    // silently 404 on that account's private repos).
    let generic = std::env::var("GITHUB_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
        .or_else(|| std::env::var("GH_TOKEN").ok().filter(|t| !t.is_empty()));

    if let Some(generic_token) = generic {
        if accounts.len() == 1 {
            if let Some(acc) = accounts.iter_mut().find(|a| a.token.is_none()) {
                acc.token = Some(generic_token);
            }
        }
    }

    accounts
}
