//! The one place that knows the update feature's file layout under
//! `~/.vibe-station` (callers pass the vst home; tests pass a temp dir), and
//! takes `.update.lock`. `.daemon.lock` is taken in `crate::lock`.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use crate::lock::{try_lock, LockWait};

/// `~/.vibe-station`, or `None` when `$HOME` is unset (the CLI refuses rather
/// than writing under `./`).
pub fn vst_home() -> Option<PathBuf> {
    std::env::var_os("HOME")?;
    Some(vst_git::paths::Paths::default_home().vst_home().clone())
}

/// `update-state.json`: `StateStore`'s file.
pub fn update_state(home: &Path) -> PathBuf {
    home.join("update-state.json")
}

/// Serialises installs and `update-state.json` writers (daemon, CLI fallback, watcher).
pub fn update_lock(home: &Path) -> PathBuf {
    home.join(".update.lock")
}

/// The single-daemon lock (taken by `crate::lock`; the watcher also takes it
/// before replacing the DB).
pub fn daemon_lock(home: &Path) -> PathBuf {
    home.join(".daemon.lock")
}

/// The SQLite database.
pub fn db(home: &Path) -> PathBuf {
    home.join("vibe-station.db")
}

/// The database's `-wal` / `-shm` sidecars.
pub fn db_sidecars(home: &Path) -> [PathBuf; 2] {
    [
        home.join("vibe-station.db-wal"),
        home.join("vibe-station.db-shm"),
    ]
}

/// Where a snapshot restore is staged beside the DB before the atomic rename.
pub fn db_restore_staging(home: &Path) -> PathBuf {
    home.join("vibe-station.db.restore")
}

/// The pre-restart DB snapshot a rollback restores.
pub fn prev_db_snapshot(home: &Path) -> PathBuf {
    home.join(".prev").join("vibe-station.db")
}

/// The restart handoff file.
pub fn handoff(home: &Path) -> PathBuf {
    home.join("restart-handoff.json")
}

/// The rollback watcher's log (its stdout and its own lines).
pub fn watch_log(home: &Path) -> PathBuf {
    home.join("logs").join("update-watch.log")
}

/// Take `.update.lock` (retrying per `wait`). `Ok(None)` = held elsewhere.
pub fn try_update_lock(home: &Path, wait: LockWait) -> io::Result<Option<File>> {
    try_lock(&update_lock(home), wait)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_stable() {
        // On-disk names are read by older/newer binaries across restarts and rollbacks.
        let h = Path::new("/h");
        assert_eq!(update_state(h), Path::new("/h/update-state.json"));
        assert_eq!(update_lock(h), Path::new("/h/.update.lock"));
        assert_eq!(daemon_lock(h), Path::new("/h/.daemon.lock"));
        assert_eq!(prev_db_snapshot(h), Path::new("/h/.prev/vibe-station.db"));
        assert_eq!(handoff(h), Path::new("/h/restart-handoff.json"));
        assert_eq!(watch_log(h), Path::new("/h/logs/update-watch.log"));
    }

    #[test]
    fn update_lock_is_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let held = try_update_lock(dir.path(), LockWait::NONE)
            .unwrap()
            .unwrap();
        assert!(try_update_lock(dir.path(), LockWait::NONE)
            .unwrap()
            .is_none());
        drop(held);
        assert!(try_update_lock(dir.path(), LockWait::NONE)
            .unwrap()
            .is_some());
    }
}
