//! `vst artifact add <path>... [--json]`
//!
//! ONE `POST /artifacts` for all paths (one rate-limit token). The scope comes
//! from `$VST_SPAWN_TOKEN` on the daemon side; paths are made absolute against
//! the current directory here.

use std::path::{Path, PathBuf};

use vst_types::rest::artifacts::{
    AddArtifactResult, AddArtifactsRequest, AddArtifactsResponse, ArtifactErrorCode,
};

use super::{describe_error_with, exit_code_for, parse_flags};
use crate::client::{daemon_post, DaemonResult};
use crate::env::get_vst_spawn_token;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactAddOptions {
    pub paths: Vec<String>,
    pub json: bool,
}

pub fn parse_artifact_add_options(args: &[String]) -> Result<ArtifactAddOptions, String> {
    let f = parse_flags(args)?;
    if f.worktree.is_some() || f.project.is_some() || f.unpin {
        return Err(
            "Usage: vst artifact add <path>... [--json] (the scope comes from the agent session)"
                .to_string(),
        );
    }
    if f.positional.is_empty() {
        return Err("Usage: vst artifact add <path>... [--json]".to_string());
    }
    if f.positional.len() > 50 {
        return Err("At most 50 paths per `vst artifact add`".to_string());
    }
    Ok(ArtifactAddOptions {
        paths: f.positional,
        json: f.json,
    })
}

/// Make `p` absolute against `cwd` (canonical when it exists, so a symlinked
/// spelling is recorded as the file it is).
pub fn absolute_path(cwd: &Path, p: &str) -> String {
    let joined: PathBuf = if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else {
        cwd.join(p)
    };
    std::fs::canonicalize(&joined)
        .unwrap_or(joined)
        .to_string_lossy()
        .to_string()
}

/// Human lines (stdout, stderr) and the exit code for a daemon response.
pub fn render_results(results: &[AddArtifactResult]) -> (Vec<String>, Vec<String>, i32) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut failed = 0;
    let mut not_found = 0;
    for r in results {
        match (&r.error, &r.artifact) {
            (Some(e), _) => {
                failed += 1;
                if e.code == ArtifactErrorCode::NotFound {
                    not_found += 1;
                }
                err.push(format!("error: {}: {}", r.path, e.message));
            }
            (None, Some(a)) => {
                out.push(format!("added {}", a.display_path));
                if r.outside_worktree == Some(true) {
                    out.push(format!(
                        "note: {} is outside the repo; it appears in the Artifacts tab (use Remove there to hide it)",
                        r.path
                    ));
                }
            }
            (None, None) => {
                failed += 1;
                err.push(format!("error: {}: no result", r.path));
            }
        }
    }
    let code = if failed == 0 {
        0
    } else if failed == not_found && failed == results.len() {
        2
    } else {
        1
    };
    (out, err, code)
}

pub async fn run_artifact_add(opts: ArtifactAddOptions) -> Result<(), (String, i32)> {
    let token = get_vst_spawn_token().ok_or_else(|| {
        (
            "run inside a vst agent session ($VST_SPAWN_TOKEN is not set)".to_string(),
            1,
        )
    })?;
    preflight().await;

    let cwd = std::env::current_dir().map_err(|e| (e.to_string(), 1))?;
    let body = AddArtifactsRequest {
        spawn_token: token,
        paths: opts.paths.iter().map(|p| absolute_path(&cwd, p)).collect(),
    };
    let result = daemon_post::<AddArtifactsResponse, _>("/artifacts", Some(&body))
        .await
        .map_err(|e| (e.to_string(), 1))?;

    match result {
        DaemonResult::Ok { data, .. } => {
            let (out, err, code) = render_results(&data.results);
            if opts.json {
                if let Ok(s) = serde_json::to_string_pretty(&data) {
                    println!("{s}");
                }
            } else {
                out.iter().for_each(|l| println!("{l}"));
            }
            err.iter().for_each(|l| eprintln!("{l}"));
            if code == 0 {
                Ok(())
            } else {
                // Per-path errors are already printed; exit without a 2nd line.
                Err((String::new(), code))
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::rest::artifacts::ArtifactPathError;

    fn failure(path: &str, code: ArtifactErrorCode) -> AddArtifactResult {
        AddArtifactResult {
            path: path.into(),
            artifact: None,
            outside_worktree: None,
            error: Some(ArtifactPathError {
                code,
                message: "m".into(),
            }),
        }
    }

    #[test]
    fn parse_requires_paths_and_rejects_scope_flags() {
        assert!(parse_artifact_add_options(&[]).is_err());
        assert!(parse_artifact_add_options(&["--worktree=w".into(), "a".into()]).is_err());
        let o = parse_artifact_add_options(&["a".into(), "b".into(), "--json".into()]).unwrap();
        assert_eq!(o.paths, vec!["a", "b"]);
        assert!(o.json);
    }

    #[test]
    fn relative_paths_become_absolute() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a.md"), "x").unwrap();
        let abs = absolute_path(t.path(), "a.md");
        assert!(Path::new(&abs).is_absolute());
        assert!(abs.ends_with("a.md"));
        // a missing file keeps the joined absolute path (the daemon answers NOT_FOUND)
        let missing = absolute_path(t.path(), "nope.md");
        assert!(Path::new(&missing).is_absolute() && missing.ends_with("nope.md"));
    }

    #[test]
    fn exit_codes_follow_the_contract() {
        assert_eq!(render_results(&[]).2, 0);
        let all_missing = [failure("/a", ArtifactErrorCode::NotFound)];
        assert_eq!(render_results(&all_missing).2, 2);
        let denied = [failure("/a", ArtifactErrorCode::ArtifactDenied)];
        assert_eq!(render_results(&denied).2, 1);
        let ineligible = [failure("/a", ArtifactErrorCode::ArtifactIneligible)];
        assert_eq!(render_results(&ineligible).2, 1);
        let mixed = [
            failure("/a", ArtifactErrorCode::NotFound),
            failure("/b", ArtifactErrorCode::ArtifactDenied),
        ];
        assert_eq!(render_results(&mixed).2, 1);
    }
}
