//! `vst files open [--worktree <id> | --project <id>] <path> [--json]`
//!
//! Sends `POST /worktrees/:id/open-files` or `POST /projects/:id/open-files`
//! to add a path to the durable open-file set.

use vst_types::rest::worktrees::{OpenFilesBody, OpenFilesResult};

use super::{parse_files_options, resolve_scope, FilesOptions};
use crate::client::{daemon_post, DaemonResult};
use crate::output::print_json;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct FilesOpenOptions {
    /// Resolved target id and path segment ("worktrees" | "projects").
    pub scope: (String, String),
    pub path: String,
    pub json: bool,
}

pub fn parse_files_open_options(args: &[String]) -> Result<FilesOpenOptions, String> {
    let opts: FilesOptions = parse_files_options(args)?;
    if opts.positional.len() != 1 {
        return Err(
            "Usage: vst files open --worktree <id> <path> | --project <id> <path>".to_string(),
        );
    }
    let scope = resolve_scope(&opts)?;
    Ok(FilesOpenOptions {
        scope,
        path: opts.positional[0].clone(),
        json: opts.json,
    })
}

pub async fn run_files_open(opts: FilesOpenOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let (id, seg) = &opts.scope;
    let body = OpenFilesBody {
        path: opts.path.clone(),
    };
    let result = daemon_post::<OpenFilesResult, _>(&format!("/{seg}/{id}/open-files"), Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }
            println!("Opened file: {}", opts.path);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}
