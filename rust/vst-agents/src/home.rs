//! Home-directory resolution + a test seam for redirecting it.
//!
//! Several plugin methods derive paths under the user's home directory
//! (`~/.vibe-station/agy-logs`, `~/.claude`, `~/.cursor`, `~/.gemini`). The TS
//! tests mock `node:os.homedir()`; the Rust tests need
//! an equivalent seam. This module exposes a process-wide override guarded by
//! a mutex so tests can point it at a temp dir without racing other tests.
//!
//! Production call sites never touch the override — it defaults to `$HOME`.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static HOME_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
/// Serializes tests that mutate the home override (only those tests touch it,
/// so it never contends with production code paths).
static HOME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn home_override() -> &'static Mutex<Option<PathBuf>> {
    HOME_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// The effective home directory (`$HOME`, or the test override if set).
pub fn home_dir() -> PathBuf {
    if let Some(h) = home_override()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return h;
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Guard returned by [`with_home`]; resets the override on drop.
pub struct HomeGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
}

/// Redirect the home dir to `temp_home` for the duration of the returned
/// guard. Only safe to use from tests; all home-mutating tests must hold the
/// returned guard to avoid racing each other.
pub fn with_home(temp_home: PathBuf) -> HomeGuard {
    let lock = HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *home_override()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(temp_home);
    HomeGuard { _lock: lock }
}
