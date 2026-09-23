//! `vst files ls [--worktree <id> | --project <id>] [--json]`
//!
//! Sends `GET /worktrees/:id/open-files` or `GET /projects/:id/open-files` and
//! prints the durable open-file set.

use vst_types::rest::worktrees::OpenFilesResult;

use super::{parse_files_options, resolve_scope, FilesOptions};
use crate::client::{daemon_get, DaemonResult};
use crate::output::print_json;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct FilesLsOptions {
    /// Resolved target id and path segment ("worktrees" | "projects").
    pub scope: (String, String),
    pub json: bool,
}

pub fn parse_files_ls_options(args: &[String]) -> Result<FilesLsOptions, String> {
    let opts: FilesOptions = parse_files_options(args)?;
    if !opts.positional.is_empty() {
        return Err("Usage: vst files ls --worktree <id> | --project <id>".to_string());
    }
    let scope = resolve_scope(&opts)?;
    Ok(FilesLsOptions {
        scope,
        json: opts.json,
    })
}

pub async fn run_files_ls(opts: FilesLsOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let (id, seg) = &opts.scope;
    let result = daemon_get::<OpenFilesResult>(&format!("/{seg}/{id}/open-files"))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }
            for path in &data.paths {
                println!("{path}");
            }
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}
