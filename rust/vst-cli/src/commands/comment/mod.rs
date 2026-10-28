//! `vst comment list|show` — an agent reads the review comments left for it.
//!
//! Every path is root-relative (`/worktrees/:id/comments`, `/comments/:id`);
//! `client::api_path` adds `/api`. The scope comes from `--worktree` /
//! `--project`, defaulting to `$VST_WORKTREE` then `$VST_PROJECT` (the same
//! resolution as `vst artifact`). Comment bodies go to stdout only; nothing here
//! logs them.

pub mod list;
pub mod show;

use crate::commands::artifact::{exit_code_for as artifact_exit_code, resolve_scope};

/// Parsed flags plus positionals.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CommentFlags {
    pub worktree: Option<String>,
    pub project: Option<String>,
    pub json: bool,
    pub unsent: bool,
    pub positional: Vec<String>,
}

pub fn parse_flags(args: &[String]) -> Result<CommentFlags, String> {
    let mut f = CommentFlags::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--worktree" => {
                f.worktree = Some(iter.next().cloned().ok_or("--worktree needs a value")?)
            }
            s if s.starts_with("--worktree=") => {
                f.worktree = Some(s["--worktree=".len()..].to_string())
            }
            "--project" => f.project = Some(iter.next().cloned().ok_or("--project needs a value")?),
            s if s.starts_with("--project=") => {
                f.project = Some(s["--project=".len()..].to_string())
            }
            "--json" => f.json = true,
            "--unsent" => f.unsent = true,
            other if other.starts_with('-') => return Err(format!("Unknown option: {other}")),
            other => f.positional.push(other.to_string()),
        }
    }
    Ok(f)
}

/// The comments collection path of the resolved scope.
pub fn comments_path(worktree: Option<String>, project: Option<String>) -> Result<String, String> {
    let scope = resolve_scope(worktree, project)?;
    Ok(format!("/{}/{}/comments", scope.segment, scope.id))
}

/// Exit code for a failed daemon call: 404 -> 2 (not found), else 1.
pub fn exit_code_for(status: u16) -> i32 {
    artifact_exit_code(status)
}

/// Readable text for a daemon error: the known code's wording, else the
/// daemon's own `message`, else the bare code.
pub fn describe_error_with(code: &str, message: Option<&str>) -> String {
    match (describe_error(code), message) {
        (text, Some(m)) if text == code && !m.is_empty() => m.to_string(),
        (text, _) => text,
    }
}

/// Readable text for a daemon error code.
pub fn describe_error(code: &str) -> String {
    match code {
        "not_found" => "not found".to_string(),
        "invalid_delivery" => "invalid delivery filter".to_string(),
        other => other.to_string(),
    }
}

/// `L12` / `L12-14`, or empty for a quote-only comment.
pub fn lines_label(c: &vst_types::review::ReviewComment) -> String {
    match c.display_lines() {
        Some(l) if l.start == l.end => format!("L{}", l.start),
        Some(l) => format!("L{}-{}", l.start, l.end),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn flags_parse_both_value_forms() {
        let f = parse_flags(&s(&["--worktree=w", "--unsent", "--json", "x"])).unwrap();
        assert_eq!(f.worktree.as_deref(), Some("w"));
        assert!(f.unsent && f.json);
        assert_eq!(f.positional, vec!["x"]);
        assert!(parse_flags(&s(&["--nope"])).is_err());
        assert!(parse_flags(&s(&["--project"])).is_err());
    }
}
