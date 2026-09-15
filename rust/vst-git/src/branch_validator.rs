//! Ports `branchValidator.ts` — branch name validation per
//! HIGH-LEVEL-DESIGN.md §5.

use crate::git::branch_exists;

/// Result of validating a branch name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub ok: bool,
    pub reason: Option<String>,
}

/// Branch-name regex: `^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`.
fn valid_chars(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '/' || c == '-')
}

/// Validate a branch name against git-safe rules. Does NOT check whether the
/// branch exists in a repo.
pub fn validate_branch(name: &str) -> ValidationResult {
    if name.trim().is_empty() {
        return ValidationResult {
            ok: false,
            reason: Some("Branch name cannot be empty".to_string()),
        };
    }
    const MAX_LEN: usize = 200;
    if name.chars().count() > MAX_LEN {
        return ValidationResult {
            ok: false,
            reason: Some(format!("Branch name exceeds {MAX_LEN} character limit")),
        };
    }
    if name.contains("..") {
        return ValidationResult {
            ok: false,
            reason: Some("Branch name cannot contain \"..\"".to_string()),
        };
    }
    if !valid_chars(name) {
        return ValidationResult {
            ok: false,
            reason: Some(
                "Branch name must start with an alphanumeric character and contain only [a-zA-Z0-9._/-]"
                    .to_string(),
            ),
        };
    }
    ValidationResult {
        ok: true,
        reason: None,
    }
}

/// Returns true if `branch` already exists in the repo at `repo_path`.
/// Callers should treat `true` as a conflict (409 semantics).
pub async fn branch_exists_in_repo(repo_path: &str, branch: &str) -> bool {
    branch_exists(repo_path, branch).await
}
