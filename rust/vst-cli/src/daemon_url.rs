use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::output::die;

/// Set once by `launch::ensure_daemon_reachable()` (`cli-daemon-unification`
/// Part 03) after a self-heal confirms a fresh daemon is reachable. Checked
/// by `get_daemon_url_from_home` — deliberately **not** by
/// `get_daemon_url_from_home_and_env`, which stays a pure function of its
/// arguments so its own unit tests aren't order-dependent on other tests in
/// the same binary touching this global.
static SELF_HEAL_OVERRIDE: OnceLock<String> = OnceLock::new();

/// Record the daemon URL a self-heal just confirmed is reachable. Every
/// subsequent `get_daemon_url()`/`get_daemon_url_from_home(None)` call for
/// the rest of this process's lifetime returns this value, ahead of
/// `VST_DAEMON_URL` — R44: self-heal must never leave a stale env var
/// permanently defeating itself for every later request in this process.
pub fn set_self_heal_override(url: String) {
    let _ = SELF_HEAL_OVERRIDE.set(url);
}

#[derive(Deserialize)]
struct ConfigFile {
    port: Option<u16>,
    #[serde(rename = "cliToken")]
    cli_token: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn read_config_file_from(path: &Path) -> Option<ConfigFile> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<ConfigFile>(&content).ok()
}

pub fn get_daemon_url_from_home_and_env(
    home: Option<&Path>,
    env_override: Option<String>,
) -> Option<String> {
    if let Some(env_url) = env_override {
        if !env_url.trim().is_empty() {
            return Some(env_url);
        }
    }

    let home_path = match home {
        Some(h) => h.to_path_buf(),
        None => home_dir()?,
    };
    let config_path = home_path.join(".vibe-station").join("config.json");
    let config = read_config_file_from(&config_path)?;
    let port = config.port?;
    if port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

pub fn get_daemon_url_from_home(home: Option<&Path>) -> Option<String> {
    if let Some(url) = SELF_HEAL_OVERRIDE.get() {
        return Some(url.clone());
    }
    let env_url = env::var("VST_DAEMON_URL").ok();
    get_daemon_url_from_home_and_env(home, env_url)
}

pub fn get_daemon_token_from_home(home: Option<&Path>) -> Option<String> {
    let home_path = match home {
        Some(h) => h.to_path_buf(),
        None => home_dir()?,
    };
    let config_path = home_path.join(".vibe-station").join("config.json");
    let config = read_config_file_from(&config_path)?;
    config.cli_token
}

pub fn get_daemon_url() -> Option<String> {
    get_daemon_url_from_home(None)
}

pub fn get_daemon_url_or_throw() -> String {
    match get_daemon_url() {
        Some(url) => url,
        None => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(4),
        ),
    }
}

pub fn get_daemon_token() -> Option<String> {
    get_daemon_token_from_home(None)
}
