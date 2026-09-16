use std::env;
use std::path::{Path, PathBuf};

/// `~/.vibe-station/logs/daemon.log`
pub fn daemon_log_path() -> PathBuf {
    daemon_log_path_from_home(None)
}

pub fn daemon_log_path_from_home(home: Option<&Path>) -> PathBuf {
    let base = match home {
        Some(h) => h.to_path_buf(),
        None => home_dir().unwrap_or_else(|| PathBuf::from(".")),
    };
    base.join(".vibe-station").join("logs").join("daemon.log")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}
