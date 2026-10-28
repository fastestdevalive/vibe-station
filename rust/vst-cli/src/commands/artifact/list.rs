//! `vst artifact list [--worktree <id> | --project <id>] [--json]`

use vst_types::artifacts::ArtifactRow;
use vst_types::rest::artifacts::ArtifactListResponse;

use super::{describe_error_with, exit_code_for, parse_flags, resolve_scope, ArtifactScope};
use crate::client::{daemon_get, DaemonResult};
use crate::output::format_table;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactListOptions {
    pub scope: ArtifactScope,
    pub json: bool,
}

pub fn parse_artifact_list_options(args: &[String]) -> Result<ArtifactListOptions, String> {
    let f = parse_flags(args)?;
    if !f.positional.is_empty() || f.unpin {
        return Err("Usage: vst artifact list [--worktree <id> | --project <id>] [--json]".into());
    }
    Ok(ArtifactListOptions {
        scope: resolve_scope(f.worktree, f.project)?,
        json: f.json,
    })
}

/// Table lines for the rows (`id`, state, edits, path).
pub fn render_table(items: &[ArtifactRow]) -> Vec<String> {
    let rows: Vec<Vec<String>> = items
        .iter()
        .map(|a| {
            let mut flags = String::new();
            if a.pinned {
                flags.push_str("pinned ");
            }
            if !a.in_repo {
                flags.push_str("outside-repo ");
            }
            flags.push_str(&format!("{:?}", a.state).to_lowercase());
            vec![
                a.id.clone(),
                flags,
                a.edit_count.to_string(),
                a.display_path.clone(),
            ]
        })
        .collect();
    format_table(&["ID", "STATE", "EDITS", "PATH"], &rows)
}

pub async fn fetch_list(scope: &ArtifactScope) -> Result<ArtifactListResponse, (String, i32)> {
    let result = daemon_get::<ArtifactListResponse>(&scope.list_path())
        .await
        .map_err(|e| (e.to_string(), 1))?;
    match result {
        DaemonResult::Ok { data, .. } => Ok(data),
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

pub async fn run_artifact_list(opts: ArtifactListOptions) -> Result<(), (String, i32)> {
    preflight().await;
    let data = fetch_list(&opts.scope).await?;
    if opts.json {
        if let Ok(s) = serde_json::to_string_pretty(&data) {
            println!("{s}");
        }
    } else if data.items.is_empty() {
        println!("No artifacts yet. Files agents write appear here; use `vst artifact add <path>` to add one.");
    } else {
        render_table(&data.items)
            .iter()
            .for_each(|l| println!("{l}"));
    }
    Ok(())
}
