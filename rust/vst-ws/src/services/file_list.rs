//! Flat file listing for a worktree, used by Quick Open file search.
//!
//! Ports `daemon/src/services/fileList.ts`. Two backends:
//!   1. `rg --files` (preferred): respects .gitignore (including nested ignore
//!      files), multithreaded, fast on large repos.
//!   2. A recursive `walkdir` walk (fallback when `rg` is not on PATH): reads
//!      only the root `.gitignore`.
//!
//! Both backends skip `.git/`, include dotfiles by default, and cap the result
//! at [`MAX_ENTRIES`], returning `truncated: true` on overflow.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// The result of a file listing.
#[derive(Debug, Clone, PartialEq)]
pub struct FileListResult {
    pub files: Vec<String>,
    pub truncated: bool,
    /// `"ripgrep"` or `"node"`.
    pub source: String,
}

/// Effective cap on the number of returned entries.
pub const MAX_ENTRIES: usize = 100_000;

/// A handle for listing files, with configurable ripgrep availability and an
/// overridable entry cap (test hooks).
#[derive(Debug, Default)]
pub struct FileList {
    rg_forced: Mutex<Option<bool>>,
    max_entries: AtomicUsize,
}

impl FileList {
    pub fn new() -> Self {
        FileList {
            rg_forced: Mutex::new(None),
            max_entries: AtomicUsize::new(MAX_ENTRIES),
        }
    }

    /// Test-only: force the ripgrep-availability answer without running
    /// `rg --version`. `None` restores auto-detection.
    pub fn set_ripgrep_available(&self, available: Option<bool>) {
        *self.rg_forced.lock().unwrap() = available;
    }

    /// Test-only: override the effective entry cap.
    pub fn set_max_entries_for_test(&self, n: usize) {
        self.max_entries.store(n, Ordering::SeqCst);
    }

    fn effective_max(&self) -> usize {
        self.max_entries.load(Ordering::SeqCst)
    }

    fn has_rg(&self) -> bool {
        if let Some(forced) = *self.rg_forced.lock().unwrap() {
            return forced;
        }
        match std::process::Command::new("rg")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(s) => s.success(),
            Err(_) => false,
        }
    }

    /// List every file under `wt_path` (worktree-relative paths, POSIX
    /// separators).
    pub async fn list_files(&self, wt_path: PathBuf) -> FileListResult {
        if self.has_rg() {
            match self.list_files_with_ripgrep(&wt_path).await {
                Ok(r) => r,
                Err(_) => self.list_files_with_node(&wt_path).await,
            }
        } else {
            self.list_files_with_node(&wt_path).await
        }
    }

    async fn list_files_with_ripgrep(
        &self,
        wt_path: &PathBuf,
    ) -> Result<FileListResult, std::io::Error> {
        let max = self.effective_max();
        let mut child = std::process::Command::new("rg")
            .args([
                "--files", "--hidden", "--glob", "!.git", "--glob", "!.git/**",
            ])
            .current_dir(wt_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;
        let mut buf = String::new();
        let mut out = std::io::BufReader::new(child.stdout.take().expect("stdout piped"));
        use std::io::BufRead;
        loop {
            buf.clear();
            let n = out.read_line(&mut buf)?;
            if n == 0 {
                break;
            }
            let line = buf.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            if files.len() >= max {
                truncated = true;
                let _ = child.kill();
                break;
            }
            files.push(line);
        }
        let _ = child.wait();
        Ok(FileListResult {
            files,
            truncated,
            source: "ripgrep".into(),
        })
    }

    async fn list_files_with_node(&self, wt_path: &PathBuf) -> FileListResult {
        let wt_path = wt_path.clone();
        let max = self.effective_max();

        let result = tokio::task::spawn_blocking(move || {
            let files = Arc::new(Mutex::new(Vec::new()));
            let file_count = Arc::new(AtomicUsize::new(0));
            let truncated = Arc::new(AtomicBool::new(false));

            // Build ignore matcher that respects nested .gitignore files.
            // `.require_git(false)` matters: WalkBuilder's gitignore support is
            // otherwise gated on finding an actual `.git` directory, so a plain
            // directory with only a `.gitignore` (no `.git`) would silently
            // ignore nothing at all without this.
            let walker = ignore::WalkBuilder::new(&wt_path)
                .hidden(false)
                .git_ignore(true)
                .require_git(false)
                // `ignore`/`walkdir` default this to false, unlike the old
                // sequential walk (`std::fs::metadata`, which resolves
                // symlinks by default) — without it, a symlinked file's own
                // entry.file_type() reports neither is_file() nor is_dir(),
                // so it's silently skipped, and a symlinked directory is
                // never descended into at all.
                .follow_links(true)
                .filter_entry(|e| {
                    let name = e.file_name().to_string_lossy();
                    name != ".git" && name != "node_modules"
                })
                .build_parallel();

            walker.run(|| {
                let files = Arc::clone(&files);
                let file_count = Arc::clone(&file_count);
                let truncated = Arc::clone(&truncated);
                let wt_path = wt_path.clone();

                Box::new(move |entry| {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(_) => return ignore::WalkState::Continue,
                    };

                    // Skip if we've already hit the limit
                    if file_count.load(Ordering::Relaxed) >= max {
                        truncated.store(true, Ordering::Relaxed);
                        return ignore::WalkState::Quit;
                    }

                    // Only process files, not directories. Gitignore filtering
                    // (including nested .gitignore files) is already handled by
                    // WalkBuilder itself via `.git_ignore(true)` above — entries
                    // reaching this callback are never gitignored, so there is
                    // no need to re-check that here. (A prior version of this
                    // code rebuilt a full GitignoreBuilder from every parent
                    // .gitignore, from scratch, for every single file — O(N*D)
                    // extra I/O per walk, entirely redundant with WalkBuilder's
                    // own filtering, and a severe perf regression that defeated
                    // the whole point of this phase. Removed.)
                    if let Some(file_type) = entry.file_type() {
                        if file_type.is_file() {
                            let entry_path = entry.path();
                            if let Ok(rel_path) = entry_path.strip_prefix(&wt_path) {
                                let posix_path = to_posix(&rel_path.to_string_lossy());

                                // Atomically check and increment count before adding to list
                                let current_count = file_count.fetch_add(1, Ordering::SeqCst);
                                if current_count < max {
                                    if let Ok(mut files_guard) = files.lock() {
                                        files_guard.push(posix_path);
                                    }
                                } else {
                                    // We've exceeded the limit, set truncated flag
                                    truncated.store(true, Ordering::SeqCst);
                                    return ignore::WalkState::Quit;
                                }
                            }
                        }
                    }

                    ignore::WalkState::Continue
                })
            });

            // Extract results and sort for determinism
            let mut collected_files = files.lock().unwrap().clone();
            collected_files.sort();
            let was_truncated = truncated.load(Ordering::Relaxed);

            FileListResult {
                files: collected_files,
                truncated: was_truncated,
                source: "node".into(),
            }
        })
        .await;

        result.unwrap_or_else(|join_err| {
            // A JoinError here means the blocking closure PANICKED (e.g. a
            // poisoned `files`/`truncated` mutex from another walker worker
            // thread's own panic) — not "this worktree has zero files".
            // Log it loudly instead of returning an indistinguishable empty,
            // non-truncated result that reads as a legitimately empty repo.
            tracing::error!(
                error = %join_err,
                "file_list: parallel walk panicked; returning empty result"
            );
            FileListResult {
                files: vec![],
                truncated: false,
                source: "node".into(),
            }
        })
    }
}

pub(crate) fn to_posix(p: &str) -> String {
    if std::path::MAIN_SEPARATOR == '/' {
        p.to_string()
    } else {
        p.replace(std::path::MAIN_SEPARATOR, "/")
    }
}
