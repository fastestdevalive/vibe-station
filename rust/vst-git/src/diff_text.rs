//! Text of one file's diff and the rename map of a diff scope, for re-anchoring
//! review comments.
//!
//! Same git flags as the gutter diff in `vst-routes` (`color.diff=false`,
//! `core.quotepath=false`, `--no-color`) plus `GIT_TERMINAL_PROMPT=0`. Every call
//! is bounded: a timeout and `kill_on_drop`, so a hung git never pins a re-anchor
//! pass.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use vst_types::review::DiffScope;

/// Upper bound for one git invocation.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a diff query failed. The caller keeps the last known anchor.
#[derive(Debug, thiserror::Error)]
pub enum DiffTextError {
    #[error("branch diff needs a base sha")]
    MissingBase,
    #[error("base sha is not a hex object id")]
    InvalidBase,
    #[error("git did not finish within {0:?}")]
    TimedOut(Duration),
    #[error("failed to run git: {0}")]
    Io(#[from] std::io::Error),
    #[error("git diff failed: {0}")]
    Git(String),
}

/// Whether `s` is a plain abbreviated or full object id: `^[0-9a-f]{7,64}$`.
/// Anything else (notably a leading `-`) must never reach git as a revision.
pub fn is_valid_base_sha(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn base_arg(scope: DiffScope, base_sha: Option<&str>) -> Result<String, DiffTextError> {
    match scope {
        DiffScope::Local => Ok("HEAD".to_string()),
        DiffScope::Branch => {
            let sha = base_sha
                .filter(|s| !s.is_empty())
                .ok_or(DiffTextError::MissingBase)?;
            if is_valid_base_sha(sha) {
                Ok(sha.to_string())
            } else {
                Err(DiffTextError::InvalidBase)
            }
        }
    }
}

/// Run git with the shared flags. `diff` exits 1 for "differences found" with
/// `--no-index`; `ok_codes` lists the accepted non-zero codes.
async fn run(root: &Path, args: &[&str], ok_codes: &[i32]) -> Result<Vec<u8>, DiffTextError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(["-c", "color.diff=false", "-c", "core.quotepath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| DiffTextError::TimedOut(GIT_TIMEOUT))??;
    let code = out.status.code().unwrap_or(-1);
    if !out.status.success() && !ok_codes.contains(&code) {
        return Err(DiffTextError::Git(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(out.stdout)
}

/// Unified diff of `path` for a diff scope: working tree against `HEAD`
/// (`Local`) or against `base_sha` (`Branch`). `old_path` is the file's name at
/// the base when it was renamed (it is added to the pathspec so git pairs the
/// two). An untracked file in the local scope diffs against `/dev/null`.
///
/// # Errors
/// [`DiffTextError`] when git fails, hangs, or a branch diff has no base.
pub async fn file_diff(
    root: &Path,
    scope: DiffScope,
    base_sha: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Result<String, DiffTextError> {
    let base = base_arg(scope, base_sha)?;
    let mut args = vec![
        "diff",
        "--no-color",
        "--find-renames",
        "--end-of-options",
        base.as_str(),
        "--",
    ];
    if let Some(old) = old_path.filter(|o| *o != path) {
        args.push(old);
    }
    args.push(path);
    let out = run(root, &args, &[]).await?;
    if out.is_empty() && scope == DiffScope::Local {
        let tracked = run(root, &["ls-files", "--error-unmatch", "--", path], &[1])
            .await
            .map(|o| !o.is_empty())
            .unwrap_or(false);
        if !tracked && root.join(path).is_file() {
            let args = ["diff", "--no-color", "--no-index", "--", "/dev/null", path];
            let out = run(root, &args, &[1]).await?;
            return Ok(String::from_utf8_lossy(&out).into_owned());
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Absolute git dir of the checkout at `root` (`git rev-parse --absolute-git-dir`).
/// For a linked worktree this is `<main>/.git/worktrees/<name>`, outside `root`.
///
/// # Errors
/// [`DiffTextError`] when `root` is not a git checkout, or git fails or hangs.
pub async fn git_dir(root: &Path) -> Result<std::path::PathBuf, DiffTextError> {
    let out = run(root, &["rev-parse", "--absolute-git-dir"], &[]).await?;
    let text = String::from_utf8_lossy(&out);
    let line = text.trim();
    if line.is_empty() {
        return Err(DiffTextError::Git("empty git dir".into()));
    }
    Ok(std::path::PathBuf::from(line))
}

/// Renames of a diff scope as `old path -> new path`
/// (`git diff -M --name-status -z`). Empty when there are none.
///
/// # Errors
/// [`DiffTextError`] when git fails, hangs, or a branch diff has no base.
pub async fn rename_map(
    root: &Path,
    scope: DiffScope,
    base_sha: Option<&str>,
) -> Result<HashMap<String, String>, DiffTextError> {
    let base = base_arg(scope, base_sha)?;
    let out = run(
        root,
        &[
            "diff",
            "-M",
            "--name-status",
            "-z",
            "--end-of-options",
            base.as_str(),
        ],
        &[],
    )
    .await?;
    Ok(parse_rename_map(&String::from_utf8_lossy(&out)))
}

/// Parse `--name-status -z`: `R<score>\0old\0new\0`, `C<score>\0old\0new\0`
/// (copies are not moves and are skipped), `X\0path\0` for the rest.
pub fn parse_rename_map(stdout: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut it = stdout.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = it.next() {
        match status.chars().next() {
            Some('R') => {
                if let (Some(old), Some(new)) = (it.next(), it.next()) {
                    map.insert(old.to_string(), new.to_string());
                }
            }
            Some('C') => {
                it.next();
                it.next();
            }
            _ => {
                it.next();
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renames_and_skips_copies_and_plain_entries() {
        let raw =
            "M\0a.rs\0R100\0old/x.rs\0new/x.rs\0C75\0c.rs\0c2.rs\0A\0b.rs\0R086\0q.md\0r.md\0";
        let m = parse_rename_map(raw);
        assert_eq!(m.len(), 2);
        assert_eq!(m["old/x.rs"], "new/x.rs");
        assert_eq!(m["q.md"], "r.md");
    }

    #[tokio::test]
    async fn a_branch_diff_without_a_base_is_refused() {
        let r = rename_map(Path::new("."), DiffScope::Branch, None).await;
        assert!(matches!(r, Err(DiffTextError::MissingBase)));
    }
}
