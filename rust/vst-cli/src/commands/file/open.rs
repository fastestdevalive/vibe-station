//! `vst file open <worktreeId> <path>`
//!
//! Posts to `POST /worktrees/:id/open-file`. Mirrors `cli/src/commands/file/open.ts`.

use std::path::Path;

use vst_types::rest::worktrees::OpenFileBody;

use crate::client::{daemon_post, DaemonResult};
use crate::output::die;
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileOpenOptions {
    pub worktree_id: String,
    pub path: String,
}

pub fn parse_file_open_options(args: &[String]) -> Result<FileOpenOptions, String> {
    let mut positional = Vec::new();

    for arg in args {
        if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        }
        positional.push(arg.clone());
    }

    if positional.len() < 2 {
        return Err("Usage: vst file open <worktreeId> <path>".to_string());
    }

    Ok(FileOpenOptions {
        worktree_id: positional[0].clone(),
        path: positional[1].clone(),
    })
}

pub async fn run_file_open(opts: FileOpenOptions) -> Result<(), (String, i32)> {
    // Resolve path against the CLI's cwd — the daemon uses the absolute path.
    let abs_path = match Path::new(&opts.path).canonicalize() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.join(&opts.path).to_string_lossy().to_string()
        }
    };

    preflight().await;

    let body = OpenFileBody { path: abs_path };

    let result = daemon_post::<serde_json::Value, _>(
        &format!("/worktrees/{}/open-file", opts.worktree_id),
        Some(&body),
    )
    .await
    .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&data).unwrap_or_default()
            );
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            if status == 404 {
                die(&error, Some(2));
            }
            Err((error, 1))
        }
    }
}
