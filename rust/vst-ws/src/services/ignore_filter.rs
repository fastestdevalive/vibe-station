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

/// Default `alwaysShow` list when `file-tree.json` is absent or unusable.
pub const DEFAULT_ALWAYS_SHOW: [&str; 1] = ["*.png"];

/// The config is re-read per `/tree` request; warn about a bad one only once.
static CONFIG_WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn warn_config_once(msg: &str) {
    if !CONFIG_WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!("[vst] {FILE_TREE_CONFIG}: {msg}; using defaults");
    }
}

const FILE_TREE_CONFIG: &str = "file-tree.json";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_PATTERNS: usize = 64;
const MAX_PATTERN_LEN: usize = 256;

/// How the FILE TREE (not search, not the watcher) treats an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeVisibility {
    /// Not gitignored.
    Show,
    /// Gitignored but listed anyway (directory, inside an ignored directory, or
    /// matched by `alwaysShow`); rendered flagged/dimmed.
    ShowIgnored,
    /// Not listed (`node_modules`/`.git`, or an ignored file with no override).
    Hide,
}

/// An ignore matcher for a worktree.
pub struct IgnoreMatcher {
    worktree_root: PathBuf,
    /// dir (absolute) -> Gitignore from that dir's `.gitignore`.
    cache: HashMap<PathBuf, Option<Gitignore>>,
    /// Patterns that force a gitignored entry to be listed in the file tree.
    always_show: Option<Gitignore>,
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

    /// Install the tree "always show" patterns (gitignore syntax, rooted at the
    /// worktree). Invalid lines are skipped.
    pub fn with_always_show(mut self, patterns: &[String]) -> Self {
        let mut builder = GitignoreBuilder::new(&self.worktree_root);
        let mut any = false;
        for line in patterns {
            if builder.add_line(None, line).is_ok() {
                any = true;
            }
        }
        self.always_show = if any { builder.build().ok() } else { None };
        self
    }

    /// File-tree verdict for `abs_path`. `parent_ignored` = the directory being
    /// listed is itself gitignored (everything in it is then listed, flagged).
    /// `ignores()` is deliberately left strict: the watcher, search index and
    /// `rg` all keep gitignore semantics.
    pub fn tree_visibility(
        &mut self,
        abs_path: &str,
        is_dir: bool,
        parent_ignored: bool,
    ) -> TreeVisibility {
        let Ok(rel) = Path::new(abs_path).strip_prefix(&self.worktree_root) else {
            return TreeVisibility::Show;
        };
        if rel.as_os_str().is_empty() || rel.starts_with("..") {
            return TreeVisibility::Show;
        }
        let rel = rel.to_path_buf();
        // `ignores()` covers the hard-hidden segments, so hard-hidden entries
        // can never be revealed by an override.
        if !self.ignores(abs_path, is_dir) {
            return TreeVisibility::Show;
        }
        let hard_hidden = rel
            .components()
            .any(|c| ALWAYS_IGNORED.contains(&c.as_os_str().to_string_lossy().as_ref()));
        if hard_hidden {
            return TreeVisibility::Hide;
        }
        let overridden = self
            .always_show
            .as_ref()
            .is_some_and(|g| g.matched_path_or_any_parents(&rel, is_dir).is_ignore());
        if overridden || is_dir || parent_ignored {
            TreeVisibility::ShowIgnored
        } else {
            TreeVisibility::Hide
        }
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
        always_show: None,
    }
}

/// Read the tree "always show" list from `<vst_home>/file-tree.json`
/// (`{"alwaysShow": ["*.png"]}`). Missing, oversized, non-regular, unparsable
/// or wrong-shaped → [`DEFAULT_ALWAYS_SHOW`]; an explicit `[]` is honored.
pub async fn load_always_show(vst_home: &Path) -> Vec<String> {
    let default = || DEFAULT_ALWAYS_SHOW.iter().map(|s| s.to_string()).collect();
    let path = vst_home.join(FILE_TREE_CONFIG);
    let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
        return default(); // absent is the normal case
    };
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        warn_config_once("not a regular file <= 64 KiB");
        return default();
    }
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        warn_config_once("invalid JSON");
        return default();
    };
    let Some(list) = value.get("alwaysShow").and_then(|v| v.as_array()) else {
        return default();
    };
    list.iter()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#') && s.len() <= MAX_PATTERN_LEN)
        .take(MAX_PATTERNS)
        .map(str::to_string)
        .collect()
}
