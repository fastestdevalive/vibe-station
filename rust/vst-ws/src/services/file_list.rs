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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

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
        let max = self.effective_max();
        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;

        let ig = std::fs::read_to_string(wt_path.join(".gitignore"))
            .ok()
            .and_then(|contents| {
                let mut b = ignore::gitignore::GitignoreBuilder::new(wt_path);
                for line in contents.lines() {
                    let _ = b.add_line(None, line);
                }
                b.build().ok()
            });

        let mut stack = vec![wt_path.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let file_type = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == "node_modules" {
                    continue;
                }
                let abs = entry.path();
                let rel = abs
                    .strip_prefix(wt_path)
                    .map(|r| to_posix(&r.to_string_lossy()))
                    .unwrap_or_default();
                if let Some(ig) = &ig {
                    if ig
                        .matched_path_or_any_parents(std::path::Path::new(&rel), file_type.is_dir())
                        .is_ignore()
                    {
                        continue;
                    }
                }
                let is_dir = if file_type.is_symlink() {
                    std::fs::metadata(&abs).map(|m| m.is_dir()).unwrap_or(false)
                } else {
                    file_type.is_dir()
                };
                if is_dir {
                    stack.push(abs);
                } else {
                    if files.len() >= max {
                        truncated = true;
                        break;
                    }
                    files.push(rel);
                }
            }
            if truncated {
                break;
            }
        }

        FileListResult {
            files,
            truncated,
            source: "node".into(),
        }
    }
}

fn to_posix(p: &str) -> String {
    if std::path::MAIN_SEPARATOR == '/' {
        p.to_string()
    } else {
        p.replace(std::path::MAIN_SEPARATOR, "/")
    }
}
