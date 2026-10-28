//! `vst artifact add|list|pin` — the files an agent wrote, per worktree/project.
//!
//! Every path is root-relative (`/artifacts`, `/worktrees/:id/artifacts`);
//! `client::api_path` adds `/api`. The scope of `add` comes from the daemon
//! (spawn token -> session), never from a flag or env var.

pub mod add;
pub mod list;
pub mod pin;

use crate::env::{get_vst_project, get_vst_worktree};

/// Which artifact list a command targets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactScope {
    /// REST segment: `"worktrees"` or `"projects"`.
    pub segment: &'static str,
    pub id: String,
}

impl ArtifactScope {
    pub fn list_path(&self) -> String {
        format!("/{}/{}/artifacts", self.segment, self.id)
    }
}

/// Resolve `--worktree`/`--project`, defaulting to `$VST_WORKTREE`, then
/// `$VST_PROJECT`.
pub fn resolve_scope(
    worktree: Option<String>,
    project: Option<String>,
) -> Result<ArtifactScope, String> {
    resolve_scope_with(worktree, project, get_vst_worktree(), get_vst_project())
}

pub fn resolve_scope_with(
    worktree: Option<String>,
    project: Option<String>,
    env_worktree: Option<String>,
    env_project: Option<String>,
) -> Result<ArtifactScope, String> {
    match (worktree, project) {
        (Some(_), Some(_)) => Err("Use only one of --worktree or --project".to_string()),
        (Some(id), None) => Ok(ArtifactScope {
            segment: "worktrees",
            id,
        }),
        (None, Some(id)) => Ok(ArtifactScope {
            segment: "projects",
            id,
        }),
        (None, None) => {
            if let Some(id) = env_worktree.filter(|v| !v.is_empty()) {
                Ok(ArtifactScope {
                    segment: "worktrees",
                    id,
                })
            } else if let Some(id) = env_project.filter(|v| !v.is_empty()) {
                Ok(ArtifactScope {
                    segment: "projects",
                    id,
                })
            } else {
                Err(
                    "Pass --worktree <id> or --project <id> (or run inside a vst agent session)"
                        .to_string(),
                )
            }
        }
    }
}

/// Parsed `--worktree/--project/--json/--unpin` flags plus positionals.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArtifactFlags {
    pub worktree: Option<String>,
    pub project: Option<String>,
    pub json: bool,
    pub unpin: bool,
    pub positional: Vec<String>,
}

pub fn parse_flags(args: &[String]) -> Result<ArtifactFlags, String> {
    let mut f = ArtifactFlags::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--worktree" => {
                f.worktree = Some(
                    iter.next()
                        .cloned()
                        .ok_or("--worktree needs a value".to_string())?,
                )
            }
            s if s.starts_with("--worktree=") => {
                f.worktree = Some(s["--worktree=".len()..].to_string())
            }
            "--project" => {
                f.project = Some(
                    iter.next()
                        .cloned()
                        .ok_or("--project needs a value".to_string())?,
                )
            }
            s if s.starts_with("--project=") => {
                f.project = Some(s["--project=".len()..].to_string())
            }
            "--json" => f.json = true,
            "--unpin" => f.unpin = true,
            other if other.starts_with('-') => return Err(format!("Unknown option: {other}")),
            other => f.positional.push(other.to_string()),
        }
    }
    Ok(f)
}

/// Exit code for a failed daemon call: 404 -> 2 (not found), else 1.
pub fn exit_code_for(status: u16) -> i32 {
    if status == 404 {
        2
    } else {
        1
    }
}

/// Readable text for a daemon error: the known code's wording, else the
/// daemon's own `message` (so e.g. `VALIDATION_ERROR` keeps its detail), else
/// the bare code.
pub fn describe_error_with(code: &str, message: Option<&str>) -> String {
    match (describe_error(code), message) {
        (text, Some(m)) if text == code && !m.is_empty() => m.to_string(),
        (text, _) => text,
    }
}

/// Readable text for a daemon error code.
pub fn describe_error(code: &str) -> String {
    match code {
        "RATE_LIMITED" => "too many artifact requests; wait a moment and retry".to_string(),
        "SESSION_ARCHIVED" => "this session is archived".to_string(),
        "PIN_LIMIT" => format!(
            "pin limit reached ({} per worktree/project); unpin one first",
            vst_types::artifacts::ARTIFACT_PIN_CAP
        ),
        "ARTIFACT_NOT_FOUND" => "no longer an artifact".to_string(),
        "NOT_FOUND" => "not found".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_codes_fall_back_to_the_daemon_message() {
        assert!(
            describe_error_with("VALIDATION_ERROR", Some("paths must hold 1..=50 entries"))
                .contains("1..=50")
        );
        assert_eq!(
            describe_error_with("VALIDATION_ERROR", None),
            "VALIDATION_ERROR"
        );
        assert_eq!(describe_error_with("NOT_FOUND", Some("x")), "not found");
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn scope_flags_win_then_env_worktree_then_env_project() {
        let sc = resolve_scope_with(Some("w".into()), None, Some("ew".into()), None).unwrap();
        assert_eq!(sc.list_path(), "/worktrees/w/artifacts");
        let sc = resolve_scope_with(None, None, Some("ew".into()), Some("ep".into())).unwrap();
        assert_eq!(sc.list_path(), "/worktrees/ew/artifacts");
        let sc = resolve_scope_with(None, None, None, Some("ep".into())).unwrap();
        assert_eq!(sc.list_path(), "/projects/ep/artifacts");
        assert!(resolve_scope_with(None, None, None, None).is_err());
        assert!(resolve_scope_with(Some("a".into()), Some("b".into()), None, None).is_err());
    }

    #[test]
    fn flags_parse_both_value_forms() {
        let f = parse_flags(&s(&["--worktree=w", "--json", "x", "--unpin"])).unwrap();
        assert_eq!(f.worktree.as_deref(), Some("w"));
        assert!(f.json && f.unpin);
        assert_eq!(f.positional, vec!["x"]);
        assert!(parse_flags(&s(&["--nope"])).is_err());
        assert!(parse_flags(&s(&["--project"])).is_err());
    }
}
