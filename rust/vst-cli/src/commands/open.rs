//! `vst open [path]`
//!
//! Opens a project in vibe-station: posts `POST /open` to the daemon to upsert
//! the project and navigate the app window; if the daemon isn't running it
//! launches the app, polls `/health` until ready, then retries. Mirrors
//! `cli/src/commands/open.ts` (top-level `vst open` — distinct from
//! `vst file open`, which is ported in `commands/file/open.rs`).

use std::path::Path;
use std::time::Duration;

use reqwest::Method;

use vst_types::rest::open::OpenBody;

use crate::client::daemon_request_with_base;
use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::output::{die, success};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenOptions {
    pub path: Option<String>,
}

pub fn parse_open_options(args: &[String]) -> Result<OpenOptions, String> {
    let mut positional = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        }
        positional.push(arg.clone());
    }
    if positional.len() > 1 {
        return Err("Usage: vst open [path]".to_string());
    }
    Ok(OpenOptions {
        path: positional.first().cloned(),
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
                    cwd.join(t).to_string_lossy().to_string()
                }
            }
        }
        None => {
            let cwd = std::env::current_dir().unwrap_or_default();
            cwd.to_string_lossy().to_string()
        }
    }
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

/// Post `{ path }` to `/open` on the given base URL. Returns the project id.
pub async fn post_open_at(
    base_url: &str,
    token: Option<&str>,
    abs_path: &str,
) -> Result<String, OpenFailure> {
    let body = OpenBody {
        path: abs_path.to_string(),
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
            } else {
                Err(OpenFailure::NoDaemon)
            }
        }
    }
}

/// Launch the vibe-station desktop app in the background, detached from the
/// CLI. Best-effort: failures are ignored (the caller polls for the daemon).
pub fn launch_app() {
    if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("open")
            .args(["-a", "vibe-station"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    } else if cfg!(target_os = "linux") {
        let candidates = [
            "/usr/lib/vibe-station/vibe-station",
            "/opt/vibe-station/vibe-station",
        ];
        for bin in candidates {
            if std::process::Command::new(bin)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok()
            {
                return;
            }
        }
        if let Ok(app_image) = std::env::var("APPIMAGE") {
            let _ = std::process::Command::new(app_image)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
}

/// Poll `GET /health` on `base_url` until it responds OK or the timeout elapses.
pub async fn poll_for_daemon_at(base_url: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        let client = reqwest::Client::new();
        let ok = client
            .get(format!("{base_url}/health"))
            .timeout(Duration::from_millis(1000))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if ok {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

/// Poll the daemon URL derived from the environment/config.
pub async fn poll_for_daemon(timeout: Duration) -> bool {
    match get_daemon_url() {
        Some(url) => poll_for_daemon_at(&url, timeout).await,
        None => false,
    }
}

pub async fn run_open(opts: OpenOptions) -> Result<(), (String, i32)> {
    let abs_path = resolve_path(opts.path.as_deref());

    let base_url = get_daemon_url();
    let token = get_daemon_token();

    if let Some(url) = &base_url {
        match post_open_at(url, token.as_deref(), &abs_path).await {
            Ok(project_id) => {
                success(&format!("Opened project: {project_id}"));
                return Ok(());
            }
            Err(OpenFailure::Http { message, .. }) => {
                die(&format!("Failed to open project: {message}"), Some(1));
            }
            Err(_) => {
                // NoDaemon or Connect — fall through to launch-and-retry.
            }
        }
    }

    success("Daemon not running — launching vibe-station...");
    launch_app();

    let ready = poll_for_daemon(Duration::from_millis(10_000)).await;
    if !ready {
        die(
            "vibe-station did not start within 10 seconds. Open the app manually.",
            Some(1),
        );
    }

    let retry_url = match get_daemon_url() {
        Some(u) => u,
        None => die(
            "Failed to open project after app launch: daemon unreachable.",
            Some(1),
        ),
    };
    let retry_token = get_daemon_token();
    match post_open_at(&retry_url, retry_token.as_deref(), &abs_path).await {
        Ok(project_id) => {
            success(&format!("Opened project: {project_id}"));
            Ok(())
        }
        Err(OpenFailure::Http { message, .. }) => {
            die(
                &format!("Failed to open project after app launch: {message}"),
                Some(1),
            );
        }
        Err(_) => die(
            "Failed to open project after app launch: daemon unreachable.",
            Some(1),
        ),
    }
}
