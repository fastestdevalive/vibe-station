//! `vst files ls|open|close` — manage the durable open-file set.
//!
//! Reads/writes the same `openFiles` state the web UI syncs to, scoped to a
//! worktree (`--worktree <id>`) or a project/direct session (`--project <id>`).
//! See Phase 6/7 of the `vst-cli-path-open-and-files` plan.

pub mod close;
pub mod ls;
pub mod open;

/// Shared raw options for every `vst files` subcommand: scope flags, `--json`,
/// and any positional args. Subcommands validate the positional count and
/// resolve the scope themselves.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FilesOptions {
    pub worktree: Option<String>,
    pub project: Option<String>,
    pub json: bool,
    pub positional: Vec<String>,
}

pub fn parse_files_options(args: &[String]) -> Result<FilesOptions, String> {
    let mut opts = FilesOptions::default();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--worktree" => {
                opts.worktree = iter.next().cloned();
            }
            s if s.starts_with("--worktree=") => {
                opts.worktree = Some(s.trim_start_matches("--worktree=").to_string());
            }
            "--project" => {
                opts.project = iter.next().cloned();
            }
            s if s.starts_with("--project=") => {
                opts.project = Some(s.trim_start_matches("--project=").to_string());
            }
            "--json" => {
                opts.json = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => {
                opts.positional.push(other.to_string());
            }
        }
    }

    Ok(opts)
}

/// Resolve the scope flags into the target id and the REST path segment
/// ("worktrees" or "projects") to route the request against. Requires exactly
/// one of `--worktree`/`--project`.
pub fn resolve_scope(opts: &FilesOptions) -> Result<(String, String), String> {
    match (&opts.worktree, &opts.project) {
        (Some(w), None) => Ok((w.clone(), "worktrees".to_string())),
        (None, Some(p)) => Ok((p.clone(), "projects".to_string())),
        _ => Err("Use exactly one of --worktree or --project".to_string()),
    }
}
