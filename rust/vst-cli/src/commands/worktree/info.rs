//! `vst worktree info <id> [--json]`
//!
//! Sends `GET /worktrees/:id`. Mirrors `cli/src/commands/worktree/info.ts`.

use vst_types::rest::shared::Worktree;

use crate::client::{daemon_get, DaemonResult};
use crate::output::{print_json, print_table};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorktreeInfoOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_worktree_info_options(args: &[String]) -> Result<WorktreeInfoOptions, String> {
    let mut opts = WorktreeInfoOptions::default();
    let mut positional = Vec::new();

    for arg in args {
        match arg.as_str() {
            "--json" => {
                opts.json = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => {
                positional.push(other.to_string());
            }
        }
    }

    if positional.is_empty() {
        return Err("worktree id is required".to_string());
    }
    opts.id = positional[0].clone();
    Ok(opts)
}

pub async fn run_worktree_info(opts: WorktreeInfoOptions) -> Result<(), (String, i32)> {
    preflight().await;

    let result = daemon_get::<Worktree>(&format!("/worktrees/{}", opts.id))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            if opts.json {
                print_json(&data);
            }

            let rows = vec![
                vec!["ID".to_string(), data.id.clone()],
                vec!["Name".to_string(), data.name.clone().unwrap_or_default()],
                vec!["Project".to_string(), data.project_id.clone()],
                vec!["Branch".to_string(), data.branch.clone()],
                vec!["Base Branch".to_string(), data.base_branch.clone()],
                vec!["Created".to_string(), data.created_at.clone()],
            ];

            print_table(&["Field", "Value"], &rows);
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 { 2 } else { 1 };
            Err((error, code))
        }
    }
}
