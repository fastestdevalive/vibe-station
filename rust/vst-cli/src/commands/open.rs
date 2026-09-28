//! `vst open [path]`
//!
//! Opens a project in vibe-station: posts `POST /open` to the daemon to upsert
//! the project and navigate the app window; if the daemon isn't running it
//! launches the app, polls `/health` until ready, then retries. Mirrors
//! `cli/src/commands/open.ts` (top-level `vst open` — distinct from
//! `vst file open`, which is ported in `commands/file/open.rs`).

use std::path::{Component, Path, PathBuf};

use reqwest::Method;

use vst_types::rest::open::OpenBody;

use crate::client::daemon_request_with_base;
use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::output::{die, success};
use crate::preflight::preflight;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenOptions {
    pub path: Option<String>,
    pub force_create: bool,
}

pub fn parse_open_options(args: &[String]) -> Result<OpenOptions, String> {
    let mut positional = Vec::new();
    let mut force_create = false;
    for arg in args {
        if arg == "--force-create" {
            force_create = true;
        } else if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        } else {
            positional.push(arg.clone());
        }
    }
    if positional.len() > 1 {
        return Err("Usage: vst open [path] [--force-create]".to_string());
    }
    Ok(OpenOptions {
        path: positional.first().cloned(),
        force_create,
    })
}

/// Resolve a target path to an absolute path. Defaults to the cwd when no
/// target is given; when the target doesn't canonicalize, joins it onto the cwd.
pub fn resolve_path(target: Option<&str>) -> String {
    match target {
        Some(t) => {
            let p = Path::new(t);
            if p.is_absolute() {
                return t.to_string();
            }
            match p.canonicalize() {
                Ok(abs) => abs.to_string_lossy().to_string(),
                Err(_) => {
                    let cwd = std::env::current_dir().unwrap_or_default();
                    normalize_lexically(&cwd.join(t))
                        .to_string_lossy()
                        .to_string()
                }
            }
        }
        None => {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.to_string_lossy().to_string()
        }
    }
}

/// Lexically normalize a path, collapsing `.` and resolving `..` segments
/// without touching the filesystem. `cwd.join("./new")` produces `/cwd/./new`,
/// which a later canonicalizing caller (e.g. a fresh `vst new`) renders as
/// `/cwd/new` — without normalization the daemon would see two different
/// project paths for the same directory.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    // Leading `..` on an absolute path can't go above the root —
                    // keep it so we never silently drop to a wrong location.
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Why a `POST /open` failed — distinguishes a hard error from a
/// not-running-daemon condition (which triggers the launch-and-retry path).
#[derive(Clone, Debug, PartialEq)]
pub enum OpenFailure {
    /// No daemon URL is configured at all.
    NoDaemon,
    /// The daemon URL exists but the connection was refused.
    Connect,
    /// The daemon responded with a non-2xx status and an error message.
    Http { status: u16, message: String },
}

/// Post `{ path, force_create }` to `/open` on the given base URL. Returns the project id.
pub async fn post_open_at(
    base_url: &str,
    token: Option<&str>,
    abs_path: &str,
    force_create: bool,
) -> Result<String, OpenFailure> {
    let body = OpenBody {
        path: abs_path.to_string(),
        force_create,
    };
    let result = daemon_request_with_base::<vst_types::rest::open::OpenResult, _>(
        base_url,
        token,
        Method::POST,
        "/open",
        Some(&body),
    )
    .await;

    match result {
        Ok(crate::client::DaemonResult::Ok { data, .. }) => Ok(data.project_id),
        Ok(crate::client::DaemonResult::Err { status, error, .. }) => Err(OpenFailure::Http {
            status,
            message: error,
        }),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("ECONNREFUSED") || msg.contains("connect") {
                Err(OpenFailure::Connect)
            } else if msg.contains("was not valid JSON") {
                // The daemon answered (so it's not down / worth relaunching
                // over), but the response body wasn't what we expected —
                // surface the real error instead of misreporting it as
                // "daemon not running" and kicking off a pointless
                // launch-and-retry cycle.
                Err(OpenFailure::Http {
                    status: 0,
                    message: msg,
                })
            } else {
                Err(OpenFailure::NoDaemon)
            }
        }
    }
}

// `launch_app`/`poll_for_daemon_at`/`poll_for_daemon` moved to `crate::launch`
// (`cli-daemon-unification` Part 03) — generalized for every command's
// self-heal, not just `vst open`'s own bespoke retry. Re-exported here for
// backward compat with existing tests that reference them directly.
pub use crate::launch::{launch_app, poll_for_daemon, poll_for_daemon_at, LaunchOutcome};

pub async fn run_open(opts: OpenOptions) -> Result<(), (String, i32)> {
    let abs_path = resolve_path(opts.path.as_deref());
    let force_create = opts.force_create;

    // Found in review: this used to try `post_open_at` against `get_daemon_url()`
    // first and only fall through to self-heal on a "can't connect" result --
    // but `post_open_at` goes through `client::daemon_request_with_base`, which
    // hard-`die()`s on connection-refused itself (so this command could reach
    // its own daemon) rather than returning an `Err` this function could ever
    // observe. That meant self-heal only ever ran when `config.json` was
    // missing entirely -- the common case of "config.json exists but points at
    // a dead daemon" (true after any first run) always died immediately
    // instead of self-healing. `preflight()` is the same shared self-heal
    // entrypoint every other command already calls first; it also carries the
    // R44 stale-`VST_DAEMON_URL` re-check that this command's old bespoke
    // retry never had.
    preflight().await;

    let url = match get_daemon_url() {
        Some(u) => u,
        None => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(1),
        ),
    };
    let token = get_daemon_token();
    match post_open_at(&url, token.as_deref(), &abs_path, force_create).await {
        Ok(project_id) => {
            success(&format!("Opened project: {project_id}"));
            Ok(())
        }
        Err(OpenFailure::Http { message, .. }) => die(
            &open_failure_message(&message, &abs_path),
            Some(open_http_exit_code(&message)),
        ),
        Err(_) => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(1),
        ),
    }
}

/// Turn a daemon `POST /open` error message into a user-facing string. A
/// `path_not_found` (missing path) is the one case that hints at `--force-create`.
fn open_failure_message(message: &str, abs_path: &str) -> String {
    if message == "path_not_found" {
        format!("Path does not exist: {abs_path}\nUse --force-create to create it.")
    } else {
        format!("Failed to open project: {message}")
    }
}

/// Exit code for an `OpenFailure::Http` error. Exit code 2 is reserved for the
/// one recoverable case the PRD's CUJ 2 / R5 defines — the target path doesn't
/// exist (`path_not_found`), which hints at `--force-create`. Any other
/// daemon-side failure keeps the generic nonzero code 1.
pub fn open_http_exit_code(message: &str) -> i32 {
    if message == "path_not_found" {
        2
    } else {
        1
    }
}
