//! WebSocket message handlers.
//!
//! Ports `daemon/src/ws/handlers/*`. Each handler is a free function taking a
//! `WsConnection` (+ any dependencies it needs), mirroring the TS handler
//! shape. `session:open`/`session:close` wrap their bodies in
//! `WsConnection::with_session_lock` (Gotcha #1) — the entire body, including
//! the `await stream.attach` park point, stays inside the lock.

pub mod chat_open;
pub mod debug_log;
pub mod file_unwatch;
pub mod file_watch;
pub mod ping;
pub mod session_close;
pub mod session_input;
pub mod session_lookup;
pub mod session_open;
pub mod session_resize;
pub mod subscribe;
pub mod tree_unwatch;
pub mod tree_watch;

/// A watch `path` is only ever relative to the watched root: absolute paths
/// would make `root.join(path)` ignore the root, and `..` components step out
/// of it. `""` (the tree root) stays valid.
pub(crate) fn is_confined_watch_path(path: &str) -> bool {
    use std::path::{Component, Path};
    !path.contains('\0')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

pub(crate) const UNCONFINED_WATCH_MESSAGE: &str =
    "watch path must be relative to the root and must not contain '..'";

pub(crate) const OUTSIDE_ROOT_WATCH_MESSAGE: &str = "watch path resolves outside the root";

/// Whether `root/rel` still lies inside the canonical `root` once symlinks are
/// resolved. A not-yet-existing path is judged by its deepest existing
/// ancestor; a dangling symlink is refused (its target is unknowable).
pub(crate) fn resolves_inside_root(root: &std::path::Path, rel: &str) -> bool {
    let Ok(canon_root) = std::fs::canonicalize(root) else {
        return false;
    };
    let probe = root.join(rel);
    if std::fs::symlink_metadata(&probe).is_ok() && std::fs::canonicalize(&probe).is_err() {
        return false;
    }
    let mut cur: &std::path::Path = &probe;
    loop {
        if let Ok(canon) = std::fs::canonicalize(cur) {
            return canon.starts_with(&canon_root);
        }
        match cur.parent() {
            Some(parent) => cur = parent,
            None => return false,
        }
    }
}
