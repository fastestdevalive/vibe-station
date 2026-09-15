//! Directory-aware, nested-gitignore-aware ignore matcher for a worktree.
//!
//! Ports `daemon/src/services/ignoreFilter.ts`. The matcher:
//! - ALWAYS excludes any path containing a `node_modules` or `.git` segment,
//!   regardless of gitignore contents (defensive; matches what ripgrep does).
//!   This is what prevents inotify exhaustion on a JS repo.
//! - Walks every `.gitignore` from the worktree root down to a path's parent
//!   and applies each one relative to its own directory (git semantics for
//!   nested ignore files), lazily and cached.
//! - Appends a trailing slash when testing directory entries so directory-only
//!   patterns and their negations match.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

const ALWAYS_IGNORED: [&str; 2] = ["node_modules", ".git"];

/// An ignore matcher for a worktree.
pub struct IgnoreMatcher {
    worktree_root: PathBuf,
    /// dir (absolute) -> Gitignore from that dir's `.gitignore`.
    cache: HashMap<PathBuf, Option<Gitignore>>,
}

impl IgnoreMatcher {
    /// True if `abs_path` should be ignored. `is_dir` controls directory-pattern
    /// matching.
    pub fn ignores(&mut self, abs_path: &str, is_dir: bool) -> bool {
        let abs = Path::new(abs_path);
        let rel = match abs.strip_prefix(&self.worktree_root) {
            Ok(r) => r,
            // Outside the worktree (escaped symlink) or the root itself — never
            // ignore.
            Err(_) => return false,
        };
        if rel.as_os_str().is_empty() {
            return false;
        }
        // rel could be absolute-ish if strip_prefix gave a weird result; guard
        // against `..` traversal.
        if rel.starts_with("..") {
            return false;
        }

        let segments: Vec<&std::ffi::OsStr> = rel.components().map(|c| c.as_os_str()).collect();

        // Hard-exclude node_modules / .git anywhere in the path.
        if segments
            .iter()
            .any(|s| ALWAYS_IGNORED.contains(&s.to_string_lossy().as_ref()))
        {
            return true;
        }

        // Apply each ancestor directory's .gitignore to the remaining relative
        // path, matching git's nested-ignore semantics.
        let mut dir_abs: PathBuf = self.worktree_root.clone();
        for i in 0..segments.len() {
            if let Some(ig) = self.gitignore_for(&dir_abs) {
                let sub_rel = segments[i..]
                    .iter()
                    .map(|s| s.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                // `is_dir` tells the matcher to honour directory-only patterns
                // (and their negations) without needing a trailing slash.
                if ig
                    .matched_path_or_any_parents(Path::new(&sub_rel), is_dir)
                    .is_ignore()
                {
                    return true;
                }
            }
            dir_abs.push(&segments[i]);
        }
        false
    }

    fn gitignore_for(&mut self, dir_abs: &Path) -> Option<&Gitignore> {
        if self.cache.contains_key(dir_abs) {
            return self.cache.get(dir_abs).and_then(|o| o.as_ref());
        }
        let gitignore_path = dir_abs.join(".gitignore");
        let loaded = if gitignore_path.is_file() {
            let mut builder = GitignoreBuilder::new(dir_abs);
            if let Ok(contents) = std::fs::read_to_string(&gitignore_path) {
                for line in contents.lines() {
                    let _ = builder.add_line(None, line);
                }
            }
            builder.build().ok()
        } else {
            None
        };
        self.cache.insert(dir_abs.to_path_buf(), loaded);
        self.cache.get(dir_abs).and_then(|o| o.as_ref())
    }
}

/// Build an ignore matcher for a worktree root.
pub fn build_ignore_matcher(worktree_root: PathBuf) -> IgnoreMatcher {
    IgnoreMatcher {
        worktree_root,
        cache: HashMap::new(),
    }
}
