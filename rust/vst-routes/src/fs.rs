//! `routes/fs.ts` — GET /fs/complete and GET /fs/check.
//!
//! Ports `daemon/src/routes/fs.ts` (157 LOC):
//! - `GET /fs/check?path=<path>`
//! - `GET /fs/complete?path=<partial>`
//!
//! Read-only, directory-only, capped, and defensive.
//! Expands leading `~` or `~/...` to the user's home directory.

use std::path::{Path, PathBuf};
use vst_agents::home::home_dir;
use vst_git::git::{has_commits, is_git_repo};
use vst_types::rest::fs::{FsCheck, FsComplete, FsCompleteEntry};

pub const MAX_FS_COMPLETE_ENTRIES: usize = 50;
pub const MAX_PATH_LEN: usize = 4096;

/// Errors returned by fs route validation.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FsRouteError {
    #[error("validation_error: path exceeds maximum length of {MAX_PATH_LEN}")]
    PathTooLong,
    #[error("validation_error: path cannot contain a null byte")]
    NullByte,
    #[error("validation_error: path must be absolute (or start with ~). Got: '{0}'")]
    NotAbsolute(String),
}

impl FsRouteError {
    pub fn error_code(&self) -> &'static str {
        "validation_error"
    }
}

/// Resolve a leading `~` (either exactly `~` or `~/...`) to the user's home dir.
/// Preserves trailing slash if present on input.
pub fn expand_tilde(input: &str) -> PathBuf {
    if input == "~" {
        return home_dir();
    }
    if let Some(rest) = input.strip_prefix("~/") {
        let mut base = home_dir();
        if !rest.is_empty() {
            base.push(rest);
        }
        return base;
    }
    PathBuf::from(input)
}

/// Handler for `/fs/*`.
#[derive(Clone, Default)]
pub struct FsRoutes;

impl FsRoutes {
    pub fn new() -> Self {
        Self
    }

    fn validate_path(raw_path: &str) -> Result<PathBuf, FsRouteError> {
        if raw_path.len() > MAX_PATH_LEN {
            return Err(FsRouteError::PathTooLong);
        }
        if raw_path.contains('\0') {
            return Err(FsRouteError::NullByte);
        }

        let resolved = expand_tilde(raw_path);
        if !resolved.is_absolute() {
            return Err(FsRouteError::NotAbsolute(raw_path.to_string()));
        }
        Ok(resolved)
    }

    /// `GET /fs/check?path=<path>`
    pub async fn check(&self, raw_path: &str) -> Result<FsCheck, FsRouteError> {
        let resolved = Self::validate_path(raw_path)?;
        let metadata = match tokio::fs::metadata(&resolved).await {
            Ok(m) => m,
            Err(_) => {
                // ENOENT / EACCES - user is mid-typing or path doesn't exist
                return Ok(FsCheck {
                    exists: false,
                    is_directory: false,
                    is_git: false,
                    has_commits: None,
                });
            }
        };

        if !metadata.is_dir() {
            return Ok(FsCheck {
                exists: true,
                is_directory: false,
                is_git: false,
                has_commits: None,
            });
        }

        let resolved_str = resolved.to_string_lossy();
        let is_git = is_git_repo(&resolved_str).await;
        let commits = if is_git {
            Some(has_commits(&resolved_str).await)
        } else {
            None
        };

        Ok(FsCheck {
            exists: true,
            is_directory: true,
            is_git,
            has_commits: commits,
        })
    }

    /// `GET /fs/complete?path=<partial>`
    pub async fn complete(&self, raw_path: &str) -> Result<FsComplete, FsRouteError> {
        let resolved = Self::validate_path(raw_path)?;

        let has_trailing_sep =
            raw_path.ends_with('/') || raw_path.ends_with(std::path::MAIN_SEPARATOR);

        let (dir, prefix) = if has_trailing_sep {
            (resolved.clone(), String::new())
        } else {
            let parent = resolved
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("/"));
            let prefix = resolved
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            (parent, prefix)
        };

        let dir_str = dir.to_string_lossy().to_string();

        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => {
                // ENOENT/EACCES - user mid-typing, never 500
                return Ok(FsComplete {
                    base: dir_str,
                    entries: vec![],
                    truncated: false,
                });
            }
        };

        let mut candidates = Vec::new();

        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !prefix.is_empty() && !file_name.starts_with(&prefix) {
                continue;
            }

            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                candidates.push((file_name, entry.path(), true));
            } else if file_type.is_symlink() {
                candidates.push((file_name, entry.path(), false));
            }
        }

        // Sort by name BEFORE capping
        candidates.sort_by(|a, b| a.0.cmp(&b.0));

        let truncated = candidates.len() > MAX_FS_COMPLETE_ENTRIES;
        let selected = if truncated {
            &candidates[..MAX_FS_COMPLETE_ENTRIES]
        } else {
            &candidates[..]
        };

        let mut entries = Vec::new();
        for (name, path, is_known_dir) in selected {
            if *is_known_dir {
                entries.push(FsCompleteEntry {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                });
            } else {
                // For symlink, check if target is a directory
                if let Ok(meta) = tokio::fs::metadata(path).await {
                    if meta.is_dir() {
                        entries.push(FsCompleteEntry {
                            name: name.clone(),
                            path: path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }

        Ok(FsComplete {
            base: dir_str,
            entries,
            truncated,
        })
    }
}
