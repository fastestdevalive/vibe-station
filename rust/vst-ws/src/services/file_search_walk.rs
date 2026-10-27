//! Filesystem stat and walk helpers for file search.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio_util::sync::CancellationToken;

use super::file_list::FileList;

fn to_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn pick_time(created: io::Result<SystemTime>, modified: io::Result<SystemTime>) -> i64 {
    match (created, modified) {
        (Ok(c), _) => to_ms(c),
        (Err(_), Ok(m)) => to_ms(m),
        (Err(_), Err(_)) => 0,
    }
}

pub(crate) fn created_ms(abs: &Path) -> i64 {
    match std::fs::symlink_metadata(abs) {
        Ok(meta) => pick_time(meta.created(), meta.modified()),
        Err(_) => 0,
    }
}

/// Result of a walk: the path -> created_ms map and whether every path was
/// stat'ed. `complete == false` means some paths carry `created_ms = 0`
/// (they sort last) and the caller should leave the entry stale so a later
/// query backfills them.
pub(crate) struct WalkOutcome {
    pub files: HashMap<String, i64>,
    pub complete: bool,
}

/// List files under `root` (bounded by `walk_timeout`), then stat the ones not
/// in `prev` (bounded by a separate `walk_timeout` budget). Only a listing
/// timeout yields `None`; a stat-phase timeout keeps the listing.
pub(crate) async fn walk_and_stat(
    file_list: &FileList,
    root: &Path,
    prev: HashMap<String, i64>,
    walk_timeout: std::time::Duration,
    cancel: CancellationToken,
    #[cfg(test)] walk_delay: Option<std::time::Duration>,
    #[cfg(test)] stat_delay: Option<std::time::Duration>,
) -> Option<WalkOutcome> {
    let cancel_for_list = cancel.clone();
    let root_buf = root.to_path_buf();

    let listing = async {
        #[cfg(test)]
        if let Some(delay) = walk_delay {
            tokio::time::sleep(delay).await;
        }
        file_list
            .list_files_cancellable(root_buf.clone(), cancel_for_list)
            .await
    };
    let result = match tokio::time::timeout(walk_timeout, listing).await {
        Ok(r) => r,
        Err(_) => {
            cancel.cancel();
            return None;
        }
    };

    let cancel_for_stat = cancel.clone();
    let deadline = std::time::Instant::now() + walk_timeout;
    tokio::task::spawn_blocking(move || {
        let mut map = HashMap::with_capacity(result.files.len());
        let mut complete = true;
        for rel in result.files {
            // A prior 0 means "not stat'ed (or unknown)": retry it.
            if let Some(&ts) = prev.get(&rel).filter(|&&t| t != 0) {
                map.insert(rel, ts);
                continue;
            }
            if !complete || cancel_for_stat.is_cancelled() || std::time::Instant::now() >= deadline
            {
                complete = false;
                map.insert(rel, 0);
                continue;
            }
            #[cfg(test)]
            if let Some(d) = stat_delay {
                std::thread::sleep(d);
            }
            let ts = created_ms(&root_buf.join(&rel));
            map.insert(rel, ts);
        }
        WalkOutcome {
            files: map,
            complete,
        }
    })
    .await
    .ok()
}

pub(crate) async fn stat_paths(
    root: &Path,
    rels: Vec<String>,
    known: &HashMap<String, i64>,
) -> HashMap<String, i64> {
    let root_buf = root.to_path_buf();
    let known_clone = known.clone();
    tokio::task::spawn_blocking(move || {
        let mut map = HashMap::with_capacity(rels.len());
        for rel in rels {
            if let Some(&ts) = known_clone.get(&rel) {
                map.insert(rel, ts);
            } else {
                let ts = created_ms(&root_buf.join(&rel));
                map.insert(rel, ts);
            }
        }
        map
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pick_time_contract() {
        let t1 = UNIX_EPOCH + std::time::Duration::from_millis(12345);
        let t2 = UNIX_EPOCH + std::time::Duration::from_millis(67890);

        // (Ok(t1), Ok(t2)) -> t1 ms
        assert_eq!(pick_time(Ok(t1), Ok(t2)), 12345);

        // (Err, Ok(t2)) -> t2 ms
        assert_eq!(
            pick_time(
                Err(io::Error::new(io::ErrorKind::Other, "no birthtime")),
                Ok(t2)
            ),
            67890
        );

        // (Err, Err) -> 0
        assert_eq!(
            pick_time(
                Err(io::Error::new(io::ErrorKind::Other, "no birthtime")),
                Err(io::Error::new(io::ErrorKind::Other, "no mtime")),
            ),
            0
        );
    }
}
