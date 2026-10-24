//! One-level directory listing for the file tree (`GET /worktrees/:id/tree`,
//! `GET /projects/:id/tree`). Owns the tree's visibility rules so both routes
//! stay thin: gitignored directories are listed (flagged), gitignored files
//! only when an `alwaysShow` pattern matches, `node_modules`/`.git` never.
//! Search, `file-list` and the watcher keep strict gitignore semantics.

use std::path::Path;

use vst_types::rest::projects::{TreeEntry, TreeEntryType};

use super::ignore_filter::{build_ignore_matcher, TreeVisibility};

/// Cap on entries returned for a listing INSIDE an ignored directory
/// (`target/debug/deps` can hold tens of thousands).
pub const MAX_IGNORED_DIR_ENTRIES: usize = 2000;

/// List `target` (already resolved to lie inside `root`) for the tree. `sub` is
/// the request's relative sub-path (used to build each entry's `path`).
pub async fn list_tree_dir(
    root: &Path,
    target: &Path,
    sub: &str,
    hide_dotfiles: bool,
    always_show: &[String],
) -> std::io::Result<Vec<TreeEntry>> {
    // Canonicalize ONCE: the matcher compares against canonical entry paths
    // (macOS `/var` -> `/private/var`, symlinked checkouts).
    let canon_root = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let resolved_target = tokio::fs::canonicalize(target)
        .await
        .unwrap_or_else(|_| target.to_path_buf());

    let mut matcher = build_ignore_matcher(canon_root.clone()).with_always_show(always_show);
    // Is the directory being listed itself gitignored?
    // Checked on the resolved path AND on the lexical root-relative path, so a
    // listing reached through an in-root symlink (`inside -> real`) keeps its
    // flag when either spelling is ignored.
    let lexical_target = target
        .strip_prefix(root)
        .ok()
        .map(|rel| canon_root.join(rel));
    let parent_ignored = [Some(resolved_target.clone()), lexical_target]
        .into_iter()
        .flatten()
        .any(|p| p != canon_root && matcher.ignores(&p.to_string_lossy(), true));

    // Collect + sort the names FIRST (no stat calls), then decide visibility in
    // that order: with the cap below, `read_dir` order (hash-based on APFS/ext4)
    // would otherwise make the truncated set arbitrary.
    let mut read_dir = tokio::fs::read_dir(target).await?;
    let mut raw = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        raw.push(entry);
    }
    raw.sort_by_key(|e| e.file_name());

    let mut entries = Vec::new();
    for entry in raw {
        let name = entry.file_name().to_string_lossy().to_string();
        if hide_dotfiles && name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        let is_symlink = file_type.is_symlink();
        let is_dir = if is_symlink {
            tokio::fs::metadata(entry.path())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };

        let entry_resolved = resolved_target.join(&name);
        let visibility =
            matcher.tree_visibility(&entry_resolved.to_string_lossy(), is_dir, parent_ignored);
        let ignored = match visibility {
            TreeVisibility::Hide => continue,
            TreeVisibility::Show => None,
            TreeVisibility::ShowIgnored => Some(true),
        };
        // `resolve_inside_*` is lexical only: an ignored symlinked directory
        // pointing outside the checkout must not become browsable.
        if ignored.is_some() && is_symlink && is_dir {
            match tokio::fs::canonicalize(entry.path()).await {
                Ok(real) if real.starts_with(&canon_root) => {}
                _ => continue,
            }
        }
        if parent_ignored && entries.len() >= MAX_IGNORED_DIR_ENTRIES {
            tracing::warn!(
                "[vst] tree: listing of ignored dir truncated at {MAX_IGNORED_DIR_ENTRIES} entries: {}",
                target.display()
            );
            break;
        }

        let rel = if sub.is_empty() {
            name.clone()
        } else {
            format!("{sub}/{name}")
        };
        entries.push(TreeEntry {
            name,
            r#type: if is_dir {
                TreeEntryType::Dir
            } else {
                TreeEntryType::File
            },
            path: rel,
            ignored,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}
