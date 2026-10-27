//! Output-file watcher: a thin wrapper over `notify` so the registry only
//! sees "this file may have grown".

use std::path::Path;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// Watch `path`; `on_change` runs on notify's own thread for every
/// modify/create event (reads — `Access` — are ignored, or the output reader
/// itself would retrigger the watcher). Returns `None` if the watch cannot be
/// established.
pub(crate) fn watch_file(
    path: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Option<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(
                ev.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any
            ) {
                on_change();
            }
        }
    })
    .ok()?;
    watcher.watch(path, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}
