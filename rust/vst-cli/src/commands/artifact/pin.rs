//! `vst artifact pin <id|path> [--unpin] [--worktree <id> | --project <id>]`
//!
//! A path is resolved to an id by listing the scope and matching the canonical
//! (or display) path.

use std::path::Path;

use vst_types::artifacts::ArtifactRow;
use vst_types::rest::artifacts::{PinArtifactRequest, PinArtifactResponse};

use super::list::fetch_list;
use super::{describe_error_with, exit_code_for, parse_flags, resolve_scope, ArtifactScope};
use crate::client::{daemon_post, DaemonResult};
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactPinOptions {
    pub scope: ArtifactScope,
    pub target: String,
    pub pinned: bool,
    pub json: bool,
}

pub fn parse_artifact_pin_options(args: &[String]) -> Result<ArtifactPinOptions, String> {
    let f = parse_flags(args)?;
    if f.positional.len() != 1 {
        return Err("Usage: vst artifact pin <id|path> [--unpin] [--json]".into());
    }
    Ok(ArtifactPinOptions {
        scope: resolve_scope(f.worktree, f.project)?,
        target: f.positional[0].clone(),
        pinned: !f.unpin,
        json: f.json,
    })
}

/// Find the row `target` names: an exact id, else a path (absolute against
/// `cwd`, canonical when it exists, or the row's display path).
pub fn resolve_target<'a>(
    items: &'a [ArtifactRow],
    target: &str,
    cwd: &Path,
) -> Option<&'a ArtifactRow> {
    if let Some(a) = items.iter().find(|a| a.id == target) {
        return Some(a);
    }
    let abs = super::add::absolute_path(cwd, target);
    items
        .iter()
        .find(|a| a.path == abs || a.path == target || a.display_path == target)
}

pub async fn run_artifact_pin(opts: ArtifactPinOptions) -> Result<(), (String, i32)> {
    preflight().await;
    let list = fetch_list(&opts.scope).await?;
    let cwd = std::env::current_dir().map_err(|e| (e.to_string(), 1))?;
    let row = resolve_target(&list.items, &opts.target, &cwd)
        .ok_or_else(|| (format!("No artifact matches {}", opts.target), 2))?;

    let body = PinArtifactRequest {
        pinned: opts.pinned,
    };
    let result =
        daemon_post::<PinArtifactResponse, _>(&format!("/artifacts/{}/pin", row.id), Some(&body))
            .await
            .map_err(|e| (e.to_string(), 1))?;
    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                if let Ok(s) = serde_json::to_string_pretty(&data) {
                    println!("{s}");
                }
            } else {
                let verb = if data.artifact.pinned {
                    "Pinned"
                } else {
                    "Unpinned"
                };
                println!("{verb}: {}", data.artifact.display_path);
            }
            Ok(())
        }
        DaemonResult::Err {
            status,
            error,
            message,
            ..
        } => Err((
            describe_error_with(&error, message.as_deref()),
            exit_code_for(status),
        )),
    }
}
