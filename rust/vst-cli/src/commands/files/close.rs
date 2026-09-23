//! `vst files close [--worktree <id> | --project <id>] <path> [--json]`
//!
//! Sends `DELETE /worktrees/:id/open-files` or `DELETE /projects/:id/open-files`
//! to remove a path from the durable open-file set. The DELETE route takes a
//! JSON body, so this issues the request via `daemon_request` with
//! `Method::DELETE` directly.

use reqwest::Method;

use vst_types::rest::worktrees::{OpenFilesBody, OpenFilesResult};

use super::{parse_files_options, resolve_scope, FilesOptions};
use crate::client::{daemon_request, DaemonResult};
use crate::output::print_json;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct FilesCloseOptions {
    /// Resolved target id and path segment ("worktrees" | "projects").
    pub scope: (String, String),
    pub path: String,
    pub json: bool,
}

pub fn parse_files_close_options(args: &[String]) -> Result<FilesCloseOptions, String> {
    let opts: FilesOptions = parse_files_options(args)?;
    if opts.positional.len() != 1 {
        return Err(
            "Usage: vst files close --worktree <id> <path> | --project <id> <path>".to_string(),
        );
    }
    let scope = resolve_scope(&opts)?;
    Ok(FilesCloseOptions {
        scope,
        path: opts.positional[0].clone(),
        json: opts.json,
    })
}

pub async fn run_files_close(opts: FilesCloseOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let (id, seg) = &opts.scope;
    let body = OpenFilesBody {
        path: opts.path.clone(),
    };
    let result = daemon_request::<OpenFilesResult, _>(
        Method::DELETE,
        &format!("/{seg}/{id}/open-files"),
        Some(&body),
    )
    .await
    .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }
            println!("Closed file: {}", opts.path);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}
