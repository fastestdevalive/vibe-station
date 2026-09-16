//! `vst worktree rm <id> [--purge]`
//!
//! Sends `DELETE /worktrees/:id?purge=true|false`. Mirrors `cli/src/commands/worktree/rm.ts`.

use crate::client::{daemon_delete, DaemonResult};
use crate::confirm::confirm_by_typing_name;
use crate::output::{die, success};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorktreeRmOptions {
    pub id: String,
    pub purge: bool,
}

pub fn parse_worktree_rm_options(args: &[String]) -> Result<WorktreeRmOptions, String> {
    let mut opts = WorktreeRmOptions::default();
    let mut positional = Vec::new();

    for arg in args {
        match arg.as_str() {
            "--purge" => {
                opts.purge = true;
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

pub async fn run_worktree_rm(opts: WorktreeRmOptions) -> Result<(), (String, i32)> {
    let msg = if opts.purge {
        format!(
            "This will PERMANENTLY delete worktree \"{}\", terminate its sessions, and remove files from disk.",
            opts.id
        )
    } else {
        format!(
            "This will remove worktree \"{}\" from vst and terminate its sessions. Files stay on disk.",
            opts.id
        )
    };

    confirm_by_typing_name(&opts.id, &msg);

    preflight().await;

    // TS rm.ts always prompts for purge when --purge wasn't passed; here we
    // default to false (non-interactive for scripting) matching the safer
    // default. Users who want purge pass --purge explicitly.
    let url = if opts.purge {
        format!("/worktrees/{}?purge=true", opts.id)
    } else {
        format!("/worktrees/{}", opts.id)
    };

    let result = daemon_delete::<serde_json::Value>(&url)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { .. } => {
            if opts.purge {
                success(&format!("Worktree purged: {}", opts.id));
            } else {
                success(&format!(
                    "Worktree removed (files kept on disk): {}",
                    opts.id
                ));
            }
            Ok(())
        }
        DaemonResult::Err { status, error, .. } => {
            let code = if status == 404 {
                2
            } else if status == 409 {
                die(&error, Some(1))
            } else {
                1
            };
            Err((error, code))
        }
    }
}
