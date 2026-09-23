//! `routes/open.ts` — open project by path and navigate.
//!
//! Ports `daemon/src/routes/open.ts` (140 LOC) into Rust:
//! - `POST /open` (upsert a project by path and navigate the Tauri window to it).
//!
//! Contract:
//! - Body: { path: String }
//! - 200: { projectId: String }
//! - 400: { error: "path_not_found" | "path_not_directory" | "invalid_path", detail?: String }
//! - 500: { error: "internal_error" }
//!
//! Also maintains a 3-second navigate replay buffer so clients that connect shortly after
//! POST /open receive the navigate message.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vst_git::git::{detect_default_branch, is_git_repo};
use vst_git::prefix::{generate_project_prefix, make_unique_prefix};
use vst_git::slugify::{is_safe_project_id, slugify};
use vst_store::StoreHandle;
use vst_types::domain::ProjectRecord;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::open::{OpenBody, OpenResult};

use crate::projects::serialize_project;

fn now_iso() -> String {
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

/// Errors surfaced by `POST /open`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OpenRouteError {
    #[error("invalid_path: {0}")]
    InvalidPath(String),
    #[error("path_not_found")]
    PathNotFound,
    #[error("path_not_directory")]
    PathNotDirectory,
    #[error("internal_error: {0}")]
    Internal(String),
}

impl OpenRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::InvalidPath(_) => "invalid_path",
            Self::PathNotFound => "path_not_found",
            Self::PathNotDirectory => "path_not_directory",
            Self::Internal(_) => "internal_error",
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            Self::InvalidPath(d) if !d.is_empty() => Some(d.clone()),
            _ => None,
        }
    }
}

/// Navigate replay state (replays navigate event to newly connected clients within 3s).
#[derive(Clone, Debug)]
struct NavigateReplay {
    project_id: String,
    expires_at: Instant,
}

/// Handler for `POST /open`.
#[derive(Clone)]
pub struct OpenRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    last_navigate: Arc<Mutex<Option<NavigateReplay>>>,
}

impl OpenRoutes {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self {
            store,
            broadcaster,
            last_navigate: Arc::new(Mutex::new(None)),
        }
    }

    /// Replay any recent navigate event if not expired.
    pub fn replay_navigate(&self) -> Option<String> {
        let guard = self.last_navigate.lock().unwrap();
        if let Some(ref replay) = *guard {
            if Instant::now() < replay.expires_at {
                return Some(replay.project_id.clone());
            }
        }
        None
    }

    fn emit_navigate(&self, project_id: &str) {
        let replay = NavigateReplay {
            project_id: project_id.to_string(),
            expires_at: Instant::now() + Duration::from_secs(3),
        };
        *self.last_navigate.lock().unwrap() = Some(replay);
        self.broadcaster.send(ServerEvent::Navigate {
            project_id: project_id.to_string(),
            new_window: true,
        });
    }

    /// `POST /open`
    pub async fn open(&self, body: OpenBody) -> Result<OpenResult, OpenRouteError> {
        let raw_path = body.path.trim();
        if raw_path.is_empty() {
            return Err(OpenRouteError::InvalidPath(String::new()));
        }

        let path = Path::new(raw_path);
        if !path.is_absolute() {
            return Err(OpenRouteError::InvalidPath(
                "Path must be absolute".to_string(),
            ));
        }

        let metadata = match tokio::fs::metadata(path).await {
            Ok(m) => m,
            Err(_) => {
                // R5: a missing path errors by default; `--force-create` creates it instead.
                if body.force_create {
                    tokio::fs::create_dir_all(path)
                        .await
                        .map_err(|e| OpenRouteError::Internal(e.to_string()))?;
                    tokio::fs::metadata(path)
                        .await
                        .map_err(|e| OpenRouteError::Internal(e.to_string()))?
                } else {
                    return Err(OpenRouteError::PathNotFound);
                }
            }
        };

        if !metadata.is_dir() {
            return Err(OpenRouteError::PathNotDirectory);
        }

        // Upsert: return existing project if already registered by absolute_path
        let all_projects = self.store.get_all_projects().await;
        if let Some(existing) = all_projects.iter().find(|p| p.absolute_path == raw_path) {
            let project_id = existing.id.clone();
            let is_git = existing.is_git;
            self.emit_navigate(&project_id);
            return Ok(OpenResult { project_id, is_git });
        }

        // Register new project
        let display_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(raw_path);

        let id = slugify(display_name);
        if !is_safe_project_id(&id) {
            return Err(OpenRouteError::InvalidPath(
                "Could not derive a safe project id".to_string(),
            ));
        }

        let prefix_taken = |pfx: &str| all_projects.iter().any(|proj| proj.prefix == pfx);
        let base_pfx = generate_project_prefix(&id);
        let prefix = make_unique_prefix(&base_pfx, &prefix_taken)
            .map_err(|e| OpenRouteError::Internal(e.to_string()))?;

        let is_git = is_git_repo(raw_path).await;
        let default_branch = if is_git {
            detect_default_branch(raw_path).await
        } else {
            None
        };

        // Handle id collision: find a free one by appending a counter
        let mut final_id = id.clone();
        let mut counter = 2;
        while self.store.get_project(&final_id).await.is_some() {
            final_id = format!("{id}-{counter}");
            counter += 1;
            if !is_safe_project_id(&final_id) {
                return Err(OpenRouteError::InvalidPath(
                    "Could not derive a safe project id after deduplication".to_string(),
                ));
            }
        }

        let record = ProjectRecord {
            id: final_id.clone(),
            absolute_path: raw_path.to_string(),
            prefix,
            is_git,
            default_branch,
            created_at: now_iso(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(0),
            worktrees: vec![],
            next_worktree_num: Some(1),
            lsp_enabled: None,
            open_files: vec![],
        };

        if let Err(e) = self.store.add_project(record.clone()).await {
            // Race: another request added same id / path — try to find by path again
            let race_projects = self.store.get_all_projects().await;
            if let Some(race_existing) = race_projects.iter().find(|p| p.absolute_path == raw_path)
            {
                self.emit_navigate(&race_existing.id);
                return Ok(OpenResult {
                    project_id: race_existing.id.clone(),
                    is_git: race_existing.is_git,
                });
            }
            return Err(OpenRouteError::Internal(format!(
                "Failed to add project: {e}"
            )));
        }

        let api_project = serialize_project(&record);
        if let Ok(val) = serde_json::to_value(&api_project) {
            if let Some(map) = val.as_object() {
                self.broadcaster.send(ServerEvent::ProjectCreated {
                    project: map.clone(),
                });
            }
        }

        self.emit_navigate(&record.id);
        Ok(OpenResult {
            project_id: record.id,
            is_git: record.is_git,
        })
    }
}
