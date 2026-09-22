//! `routes/projects.ts` — projects CRUD, branches, tree, file-list, files.
//!
//! Ports `daemon/src/routes/projects.ts` (1008 LOC, 8 routes) into Rust:
//! - `GET /projects` (list all projects, ordered oldest-first by createdAt, breaking ties on id)
//! - `GET /projects/:projectId/branches` (list git branches + default branch; empty for non-git)
//! - `POST /projects` (register existing directory as project; optional git setup)
//! - `POST /projects/create` (create brand new project directory with git init + optional agent start)
//! - `PATCH /projects/:id` (toggle hidden flag with idempotent fast-path)
//! - `DELETE /projects/:id` (cascade release sessions, remove worktree checkouts, delete data dir, broadcast deletes)
//! - `GET /projects/:projectId/tree` (lazy directory listing with ignore filter)
//! - `GET /projects/:projectId/file-list` (flat file listing via ripgrep/walk)
//! - `GET /projects/:projectId/files/*` (serve file contents / images / binary detection / etag)

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use vst_agents::home::home_dir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_agents::prompt_builder::{
    build_direct_prompt, build_prompt, BuildDirectPromptInput, BuildPromptInput,
};
use vst_agents::registry::resolve_plugin;
use vst_agents::session_runtime::{release_session_runtime, ReleaseOpts};
use vst_git::branch_validator::validate_branch;
use vst_git::direct_pty::PtyKill;
use vst_git::git::{
    detect_default_branch, is_git_available, is_git_repo, list_branches, rev_parse, worktree_add,
    worktree_remove,
};
use vst_git::naming::slugify_prompt;
use vst_git::paths::Paths;
use vst_git::prefix::{generate_project_prefix, make_unique_prefix};
use vst_git::project_setup::run_project_setup;
use vst_git::session_id::{generate_session_id, reserve_next_worktree_num, tmux_name_for_session};
use vst_git::slugify::{is_safe_project_id, slugify};
use vst_git::DirectPtyRegistry;
use vst_proc::pty::PtyHandle;
use vst_proc::resolve_use_tmux::resolve_use_tmux;
use vst_proc::tmux::Tmux;
use vst_store::{StoreError, StoreHandle};
use vst_types::domain::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::projects::{
    BranchesResult, CreateNewProjectBody, CreateNewProjectResult, CreateProjectBody,
    PatchProjectBody, PatchProjectResult, TreeEntry, TreeEntryType,
};
use vst_types::rest::shared::Project;
use vst_types::rest::worktrees::FileListResult;
use vst_ws::services::file_list::FileList;
use vst_ws::services::ignore_filter::build_ignore_matcher;

use crate::modes::{find_mode, resolve_mode_id};
use crate::sessions::{serialize_session, spawn_session, SpawnSessionOpts};
use crate::worktrees::{compute_etag, serialize_worktree, FileResponse};

/// Errors surfaced by project route handlers.
#[derive(Debug, thiserror::Error)]
pub enum ProjectRouteError {
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Project '{0}' not found")]
    NotFound(String),
    #[error("Conflict: {message}")]
    Conflict {
        message: String,
        conflict_with: Option<String>,
    },
    #[error("Access denied: {0}")]
    AccessDenied(String),
    #[error("Unprocessable entity: {message}")]
    Unprocessable {
        message: String,
        reason: Option<String>,
    },
    #[error("Internal server error: {0}")]
    Internal(String),
}

impl ProjectRouteError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    pub fn conflict(msg: impl Into<String>, conflict_with: Option<String>) -> Self {
        Self::Conflict {
            message: msg.into(),
            conflict_with,
        }
    }

    pub fn unprocessable(msg: impl Into<String>, reason: Option<String>) -> Self {
        Self::Unprocessable {
            message: msg.into(),
            reason,
        }
    }
}

/// Helper to wrap PtyHandle for PtyKill
struct ProjectPtyHandleKill(PtyHandle);
impl PtyKill for ProjectPtyHandleKill {
    fn kill(&self) {
        self.0.kill();
    }
}

/// ProjectRoutes handle providing all 8 route implementations.
#[derive(Clone)]
pub struct ProjectRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    pub direct_ptys: Arc<std::sync::RwLock<HashMap<String, PtyHandle>>>,
    pub tmux: Tmux,
    pub daemon_port: u16,
    pub file_list: Arc<FileList>,
    pub paths: Paths,
}

impl ProjectRoutes {
    pub fn new(
        store: StoreHandle,
        broadcaster: Broadcaster,
        json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
        tmux: Tmux,
        daemon_port: u16,
    ) -> Self {
        Self {
            store,
            broadcaster,
            json_registry,
            direct_ptys: Arc::new(std::sync::RwLock::new(HashMap::new())),
            tmux,
            daemon_port,
            file_list: Arc::new(FileList::new()),
            paths: Paths::default(),
        }
    }

    pub fn with_paths(mut self, paths: Paths) -> Self {
        self.paths = paths;
        self
    }

    fn build_direct_pty_registry(&self) -> DirectPtyRegistry {
        let reg = DirectPtyRegistry::new();
        for (sid, handle) in self.direct_ptys.read().unwrap().iter() {
            reg.insert(sid.clone(), Arc::new(ProjectPtyHandleKill(handle.clone())));
        }
        reg
    }

    async fn release_project_session(&self, session: &SessionRecord, clear_attachments: bool) {
        let direct_pty = self.build_direct_pty_registry();
        let on_clear_idle: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        let on_clear_attachments: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        release_session_runtime(
            session,
            ReleaseOpts { clear_attachments },
            &self.json_registry,
            &direct_pty,
            &self.tmux,
            on_clear_idle,
            on_clear_attachments,
        )
        .await;
    }

    // ── 1. GET /projects ───────────────────────────────────────────────────
    pub async fn list_projects(&self) -> Vec<Project> {
        let mut projects = self.store.get_all_projects().await;
        // Order oldest-first by `createdAt`, breaking ties on `id`.
        projects.sort_by(|a, b| {
            if a.created_at != b.created_at {
                a.created_at.cmp(&b.created_at)
            } else {
                a.id.cmp(&b.id)
            }
        });
        projects.iter().map(serialize_project).collect()
    }

    // ── 2. GET /projects/:projectId/branches ──────────────────────────────
    pub async fn list_project_branches(
        &self,
        project_id: &str,
    ) -> Result<BranchesResult, ProjectRouteError> {
        let project = self.store.get_project(project_id).await.ok_or_else(|| {
            ProjectRouteError::NotFound(format!("Project '{project_id}' not found"))
        })?;

        if !project.is_git {
            return Ok(BranchesResult {
                branches: vec![],
                default_branch: None,
            });
        }

        let branches = list_branches(&project.absolute_path).await;
        let detected = detect_default_branch(&project.absolute_path).await;
        let default_branch = detected.or(project.default_branch);

        Ok(BranchesResult {
            branches,
            default_branch,
        })
    }

    // ── 3. POST /projects ─────────────────────────────────────────────────
    pub async fn create_project(
        &self,
        body: CreateProjectBody,
    ) -> Result<Project, ProjectRouteError> {
        if body.path.trim().is_empty() {
            return Err(ProjectRouteError::validation("Path must not be empty."));
        }

        if let Some(ref pfx) = body.prefix {
            let re_valid = !pfx.is_empty()
                && pfx.len() <= 6
                && pfx
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            if !re_valid {
                return Err(ProjectRouteError::validation(format!(
                    "Invalid prefix '{pfx}'. Prefix must be 1-6 lowercase alphanumeric characters."
                )));
            }
        }

        let dir_path_str = expand_tilde(&body.path);
        let dir_path = Path::new(&dir_path_str);

        if !dir_path.is_absolute() {
            return Err(ProjectRouteError::validation(format!(
                "Path must be absolute. Got: '{}'",
                body.path
            )));
        }

        match tokio::fs::metadata(dir_path).await {
            Ok(m) => {
                if !m.is_dir() {
                    return Err(ProjectRouteError::validation(format!(
                        "'{dir_path_str}' is not a directory"
                    )));
                }
            }
            Err(_) => {
                return Err(ProjectRouteError::validation(format!(
                    "Path does not exist or is not accessible: '{dir_path_str}'"
                )));
            }
        }

        let all_projects = self.store.get_all_projects().await;
        if let Some(existing) = all_projects
            .iter()
            .find(|p| p.absolute_path == dir_path_str)
        {
            return Err(ProjectRouteError::conflict(
                format!(
                    "This directory is already registered as project '{}'.",
                    existing.id
                ),
                Some(existing.id.clone()),
            ));
        }

        let is_git = is_git_repo(&dir_path_str).await;

        let display_name = body.name.as_deref().unwrap_or_else(|| {
            dir_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&dir_path_str)
        });
        let id = slugify(display_name);

        if !is_safe_project_id(&id) {
            return Err(ProjectRouteError::validation(format!(
                "Invalid project id derived from '{display_name}'."
            )));
        }

        if self.store.get_project(&id).await.is_some() {
            return Err(ProjectRouteError::conflict(
                format!("Project '{id}' already exists. Use a different name."),
                Some(id),
            ));
        }

        let prefix_taken = |pfx: &str| all_projects.iter().any(|p| p.prefix == pfx);
        let wanted_prefix = if let Some(ref pfx_override) = body.prefix {
            if let Some(collision) = all_projects.iter().find(|p| &p.prefix == pfx_override) {
                return Err(ProjectRouteError::conflict(
                    format!(
                        "Prefix '{pfx_override}' already used by project '{}'. Choose a different prefix.",
                        collision.id
                    ),
                    Some(collision.id.clone()),
                ));
            }
            pfx_override.clone()
        } else {
            let base_pfx = generate_project_prefix(&id);
            make_unique_prefix(&base_pfx, &prefix_taken)
                .map_err(|e| ProjectRouteError::Internal(e.to_string()))?
        };

        let setup_requested = body.setup.unwrap_or(false);
        let mut default_branch = None;
        if is_git {
            default_branch = detect_default_branch(&dir_path_str).await;
            if default_branch.is_none() && !setup_requested {
                return Err(ProjectRouteError::validation(format!(
                    "Could not detect default branch for '{dir_path_str}'. Pass --default-branch=<name>."
                )));
            }
        }

        let record = ProjectRecord {
            id: id.clone(),
            absolute_path: dir_path_str.clone(),
            prefix: wanted_prefix,
            is_git,
            default_branch,
            created_at: now_iso(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(0),
            worktrees: vec![],
            next_worktree_num: Some(1),
        };

        if let Err(e) = self.store.add_project(record.clone()).await {
            match e {
                StoreError::AlreadyExists(_) => {
                    return Err(ProjectRouteError::conflict(
                        format!("Project '{id}' already exists."),
                        Some(id),
                    ));
                }
                other => {
                    return Err(ProjectRouteError::Internal(format!(
                        "Failed to add project: {other}"
                    )));
                }
            }
        }

        let mut final_record = record;
        let mut warning = None;
        if setup_requested {
            match run_project_setup(&dir_path_str).await {
                Ok(()) => {
                    let redetected = detect_default_branch(&dir_path_str).await;
                    let id_clone = id.clone();
                    let mutated = self
                        .store
                        .mutate_project(&id_clone, move |p| {
                            p.is_git = true;
                            p.default_branch = redetected
                                .or_else(|| p.default_branch.clone())
                                .or_else(|| Some("main".to_string()));
                            Ok(p.clone())
                        })
                        .await;
                    match mutated {
                        Ok(updated) => {
                            final_record = updated;
                        }
                        Err(e) => {
                            warning = Some(format!("Project setup failed to update record: {e}"));
                        }
                    }
                }
                Err(e) => {
                    warning = Some(format!("Project setup failed: {e}"));
                }
            }
        }

        let mut api_project = serialize_project(&final_record);
        if let Some(w) = warning {
            api_project.warning = Some(w);
        }

        if let Ok(val) = serde_json::to_value(&api_project) {
            if let Some(map) = val.as_object() {
                self.broadcaster.send(ServerEvent::ProjectCreated {
                    project: map.clone(),
                });
            }
        }

        Ok(api_project)
    }

    // ── 4. POST /projects/create ──────────────────────────────────────────
    pub async fn create_new_project(
        &self,
        body: CreateNewProjectBody,
    ) -> Result<CreateNewProjectResult, ProjectRouteError> {
        let name = body.name.trim().to_string();

        if name.is_empty() {
            return Err(ProjectRouteError::validation(
                "Project name cannot be empty.",
            ));
        }
        if name.contains('/') || name.contains('\\') {
            return Err(ProjectRouteError::validation(
                "Project name cannot contain path separators (/ or \\).",
            ));
        }
        if name.contains("..") {
            return Err(ProjectRouteError::validation(
                "Project name cannot contain '..' (path traversal).",
            ));
        }
        if name.starts_with('.') {
            return Err(ProjectRouteError::validation(
                "Project name cannot start with a dot.",
            ));
        }

        let mut branch = "feature".to_string();
        if let Some(ref start_agent) = body.start_agent {
            if start_agent.use_worktree.unwrap_or(false) {
                branch = start_agent
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("feature")
                    .to_string();
                let branch_valid = validate_branch(&branch);
                if !branch_valid.ok {
                    return Err(ProjectRouteError::validation(
                        branch_valid
                            .reason
                            .unwrap_or_else(|| "Invalid branch name".to_string()),
                    ));
                }
                if branch == "main" {
                    return Err(ProjectRouteError::validation(
                        "Branch cannot be 'main' — it collides with the base branch.",
                    ));
                }
            }
        }

        if !is_git_available().await {
            return Err(ProjectRouteError::validation(
                "git not found in PATH. Install git to create new projects.",
            ));
        }

        let default_parent = default_projects_dir();
        let raw_parent = body.dir.as_deref().unwrap_or(&default_parent);
        let parent_dir = expand_tilde(raw_parent);
        if !Path::new(&parent_dir).is_absolute() {
            return Err(ProjectRouteError::validation(
                "Parent directory must be an absolute path.",
            ));
        }

        let project_path_buf = PathBuf::from(&parent_dir).join(&name);
        let project_path = project_path_buf.to_string_lossy().to_string();

        if project_path_buf.exists() {
            return Err(ProjectRouteError::conflict(
                format!("Directory already exists at '{project_path}'."),
                Some(project_path.clone()),
            ));
        }

        let id = slugify(&name);
        if !is_safe_project_id(&id) {
            return Err(ProjectRouteError::validation(format!(
                "Invalid project id derived from '{name}'."
            )));
        }

        if self.store.get_project(&id).await.is_some() {
            return Err(ProjectRouteError::conflict(
                format!("Project '{id}' already exists. Choose a different name."),
                Some(id),
            ));
        }

        let all_projects = self.store.get_all_projects().await;
        let base_pfx = generate_project_prefix(&id);
        let prefix = make_unique_prefix(&base_pfx, &|pfx| {
            all_projects.iter().any(|p| p.prefix == pfx)
        })
        .map_err(|e| ProjectRouteError::Internal(e.to_string()))?;

        if let Err(e) = tokio::fs::create_dir_all(&project_path_buf).await {
            return Err(ProjectRouteError::validation(format!(
                "Failed to create project directory: {e}"
            )));
        }

        if let Err(e) = run_project_setup(&project_path).await {
            let _ = tokio::fs::remove_dir_all(&project_path_buf).await;
            return Err(ProjectRouteError::validation(format!(
                "Failed to create project: {e}"
            )));
        }

        let default_branch = detect_default_branch(&project_path)
            .await
            .unwrap_or_else(|| "main".to_string());

        let record = ProjectRecord {
            id: id.clone(),
            absolute_path: project_path.clone(),
            prefix,
            is_git: true,
            default_branch: Some(default_branch.clone()),
            created_at: now_iso(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(0),
            worktrees: vec![],
            next_worktree_num: Some(1),
        };

        if let Err(e) = self.store.add_project(record.clone()).await {
            let _ = tokio::fs::remove_dir_all(&project_path_buf).await;
            return match e {
                StoreError::AlreadyExists(_) => Err(ProjectRouteError::conflict(
                    format!("Project '{id}' already exists."),
                    Some(id),
                )),
                other => Err(ProjectRouteError::Internal(format!(
                    "Failed to add project: {other}"
                ))),
            };
        }

        let api_project = serialize_project(&record);
        if let Ok(val) = serde_json::to_value(&api_project) {
            if let Some(map) = val.as_object() {
                self.broadcaster.send(ServerEvent::ProjectCreated {
                    project: map.clone(),
                });
            }
        }

        let mut result_worktree = None;
        let mut result_session = None;
        let mut warning = None;

        if let Some(ref start_agent) = body.start_agent {
            let mode_id_input = &start_agent.mode_id;
            let resolved_mode_id = resolve_mode_id(mode_id_input);
            let Some(resolved_mode_id) = resolved_mode_id else {
                return Ok(CreateNewProjectResult {
                    project: api_project,
                    worktree: None,
                    session: None,
                    warning: Some(format!(
                        "Mode '{mode_id_input}' not found. Project created but agent not started."
                    )),
                });
            };

            let prompt = start_agent.prompt.clone();
            let use_worktree = start_agent.use_worktree.unwrap_or(false);

            if use_worktree {
                // Reserve the worktree number atomically INSIDE a single mutate_project
                // call, before any I/O — matches `create_worktree_record`'s safe pattern
                // (`worktree_service.rs`). The previous code read a snapshot via
                // `get_project`, reserved a number outside any lock, did slow
                // `worktree_add` I/O, and only bumped `next_worktree_num` at the very
                // end using that stale captured number — a classic TOCTOU race: a
                // concurrent worktree creation on this project (from any code path)
                // between the snapshot read and the final bump could have already
                // moved `next_worktree_num` forward, and this handler's stale bump
                // would silently regress it backward, corrupting the counter for every
                // future create on this project (eventually producing exactly the
                // `worktrees.id` UNIQUE constraint failure this counter exists to
                // prevent). `mutate_project` takes a per-project lock and re-reads the
                // current record inside it, so reserving there is race-free.
                let paths_clone = self.paths.clone();
                let id_clone = id.clone();
                let dir_exists =
                    move |name: &str| paths_clone.worktree_path(&id_clone, name).exists();
                let wt_num_cell = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
                let wt_num_cell_closure = wt_num_cell.clone();
                let reserve_result = self
                    .store
                    .mutate_project(&id, move |p| {
                        let n = reserve_next_worktree_num(p, &dir_exists);
                        wt_num_cell_closure.store(n, std::sync::atomic::Ordering::SeqCst);
                        p.next_worktree_num = Some(n + 1);
                        Ok(p.clone())
                    })
                    .await;

                if let Err(e) = reserve_result {
                    warning = Some(format!("Failed to reserve worktree number: {e}"));
                } else {
                    let fresh_project = reserve_result.unwrap();
                    let wt_num = wt_num_cell.load(std::sync::atomic::Ordering::SeqCst);
                    let wt_id = format!("{}-{wt_num}", record.prefix);
                    let wt_path_buf = self.paths.worktree_path(&id, &wt_id);
                    let wt_path = wt_path_buf.to_string_lossy().to_string();

                    let use_tmux = resolve_use_tmux(None);
                    let base_sha = rev_parse(&project_path, &default_branch)
                        .await
                        .unwrap_or_default();

                    if let Err(e) =
                        worktree_add(&project_path, &wt_path, &branch, &default_branch).await
                    {
                        warning = Some(format!("Failed to create worktree: {e}"));
                    } else {
                        let main_session_id = generate_session_id(&wt_id, SessionType::Agent);
                        let main_tmux_name = if use_tmux {
                            tmux_name_for_session(&main_session_id)
                        } else {
                            format!("__direct__-{main_session_id}")
                        };
                        let wt_name = prompt.as_deref().and_then(|p| {
                            let s = slugify_prompt(p);
                            if s.is_empty() {
                                None
                            } else {
                                Some(s)
                            }
                        });

                        let created_at = now_iso();
                        let main_session = SessionRecord {
                            id: main_session_id.clone(),
                            worktree_id: Some(wt_id.clone()),
                            project_id: id.clone(),
                            is_main: true,
                            sort_order: 0.0,
                            r#type: SessionType::Agent,
                            mode_id: Some(resolved_mode_id.clone()),
                            name: wt_name.clone(),
                            name_source: wt_name
                                .as_ref()
                                .map(|_| vst_types::domain::SessionNameSource::Auto),
                            tmux_name: main_tmux_name,
                            use_tmux,
                            channel: Some(Channel::Tmux),
                            transcript_ref: None,
                            lifecycle: SessionLifecycle {
                                state: LifecycleState::NotStarted,
                                reason: None,
                                last_transition_at: created_at.clone(),
                            },
                            draft_prompt: None,
                            draft_config: None,
                            initial_prompt: prompt.clone(),
                            parent_session_id: None,
                            archived_at: None,
                            handoff_summary: None,
                            agent_chat_id: None,
                            acp_session_id: None,
                            model_override: None,
                            pinned_at: None,
                            superseded_by: None,
                            pr: None,
                        };

                        let worktree_record = WorktreeRecord {
                            id: wt_id.clone(),
                            name: wt_name,
                            branch: branch.clone(),
                            branch_is_placeholder: Some(false),
                            base_branch: default_branch.clone(),
                            base_sha: base_sha.clone(),
                            created_at: created_at.clone(),
                            pinned_at: None,
                            hidden_at: None,
                            sort_order: ms_now() as f64,
                            terminal_seq: Some(0),
                            agent_seq: Some(1),
                            sessions: vec![main_session.clone()],
                        };

                        // `next_worktree_num` is already correctly bumped by the reservation
                        // mutate above — don't touch it here, just push the finished record.
                        let wt_rec_clone = worktree_record.clone();
                        let _ = self
                            .store
                            .mutate_project(&id, move |p| {
                                p.worktrees.push(wt_rec_clone.clone());
                                Ok(p.clone())
                            })
                            .await;

                        let api_wt = serialize_worktree(&id, &worktree_record);
                        if let Ok(val) = serde_json::to_value(&api_wt) {
                            if let Some(map) = val.as_object() {
                                self.broadcaster.send(ServerEvent::WorktreeCreated {
                                    worktree: map.clone(),
                                });
                            }
                        }

                        let main_session_serialized =
                            serialize_session(Some(&wt_id), &id, &main_session);
                        self.broadcaster.send(ServerEvent::SessionCreated {
                            session_id: main_session_id.clone(),
                            worktree_id: Some(wt_id.clone()),
                            project_id: Some(id.clone()),
                            session_type: "agent".to_string(),
                            mode: Some(resolved_mode_id.clone()),
                            snapshot: Some((&main_session_serialized).into()),
                            parent_session_id: main_session.parent_session_id.clone(),
                        });

                        // Background spawn
                        let routes = self.clone();
                        let project_for_spawn = fresh_project.clone();
                        let wt_for_spawn = worktree_record.clone();
                        let ms_for_spawn = main_session.clone();
                        let mode_for_spawn = find_mode(&resolved_mode_id);
                        let prompt_for_spawn = prompt.clone();
                        tokio::spawn(async move {
                            routes
                                .run_worktree_agent_spawn(
                                    project_for_spawn,
                                    wt_for_spawn,
                                    ms_for_spawn,
                                    mode_for_spawn,
                                    prompt_for_spawn,
                                )
                                .await;
                        });

                        result_worktree = Some(api_wt);
                        result_session = Some(main_session_serialized);
                    }
                }
            } else {
                // Direct session
                let fresh_project = self.store.get_project(&id).await.unwrap_or(record.clone());
                let use_tmux = resolve_use_tmux(None);
                let session_id = generate_session_id(&id, SessionType::Agent);
                let tmux_name = if use_tmux {
                    tmux_name_for_session(&session_id)
                } else {
                    format!("__direct__-{session_id}")
                };
                let next_direct_seq = fresh_project.direct_session_seq.unwrap_or(0) + 1;
                let heuristic_name = prompt.as_deref().and_then(|p| {
                    let s = slugify_prompt(p);
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                });
                let session_name = heuristic_name
                    .clone()
                    .unwrap_or_else(|| format!("Direct {next_direct_seq}"));

                let created_at = now_iso();
                let session_record = SessionRecord {
                    id: session_id.clone(),
                    worktree_id: None,
                    project_id: id.clone(),
                    is_main: false,
                    sort_order: ms_now() as f64,
                    r#type: SessionType::Agent,
                    mode_id: Some(resolved_mode_id.clone()),
                    name: Some(session_name),
                    name_source: heuristic_name
                        .as_ref()
                        .map(|_| vst_types::domain::SessionNameSource::Auto),
                    tmux_name,
                    use_tmux,
                    channel: Some(Channel::Tmux),
                    transcript_ref: None,
                    lifecycle: SessionLifecycle {
                        state: LifecycleState::NotStarted,
                        reason: None,
                        last_transition_at: created_at.clone(),
                    },
                    draft_prompt: None,
                    draft_config: None,
                    initial_prompt: prompt.clone(),
                    parent_session_id: None,
                    archived_at: None,
                    handoff_summary: None,
                    agent_chat_id: None,
                    acp_session_id: None,
                    model_override: None,
                    pinned_at: None,
                    superseded_by: None,
                    pr: None,
                };

                let sess_clone = session_record.clone();
                let seq_val = next_direct_seq;
                let _ = self
                    .store
                    .mutate_project(&id, move |p| {
                        p.direct_session_seq = Some(seq_val);
                        p.direct_sessions.push(sess_clone.clone());
                        Ok(p.clone())
                    })
                    .await;

                let session_record_serialized = serialize_session(None, &id, &session_record);
                self.broadcaster.send(ServerEvent::SessionCreated {
                    session_id: session_id.clone(),
                    project_id: Some(id.clone()),
                    worktree_id: None,
                    session_type: "agent".to_string(),
                    mode: Some(resolved_mode_id.clone()),
                    snapshot: Some((&session_record_serialized).into()),
                    parent_session_id: session_record.parent_session_id.clone(),
                });

                // Background spawn
                let routes = self.clone();
                let project_for_spawn = fresh_project.clone();
                let ms_for_spawn = session_record.clone();
                let mode_for_spawn = find_mode(&resolved_mode_id);
                let prompt_for_spawn = prompt.clone();
                tokio::spawn(async move {
                    routes
                        .run_direct_agent_spawn(
                            project_for_spawn,
                            ms_for_spawn,
                            mode_for_spawn,
                            prompt_for_spawn,
                        )
                        .await;
                });

                result_session = Some(session_record_serialized);
            }
        }

        Ok(CreateNewProjectResult {
            project: api_project,
            worktree: result_worktree,
            session: result_session,
            warning,
        })
    }

    async fn run_worktree_agent_spawn(
        &self,
        fresh_project: ProjectRecord,
        worktree_record: WorktreeRecord,
        mut main_session: SessionRecord,
        mode: Option<vst_types::rest::shared::Mode>,
        prompt: Option<String>,
    ) {
        let Some(mode) = mode else {
            return;
        };
        let plugin = resolve_plugin(mode.cli);
        let built_prompt = build_prompt(&BuildPromptInput {
            project: fresh_project.clone(),
            worktree: worktree_record.clone(),
            mode_context: Some(mode.context.clone()),
            user_prompt: prompt,
            rich_chat: false,
        });

        let direct_ptys_map = std::sync::RwLock::new(HashMap::new());
        let spawn_opts = SpawnSessionOpts {
            project: &fresh_project,
            worktree: Some(&worktree_record),
            session: &main_session,
            plugin: plugin.as_ref(),
            daemon_port: self.daemon_port,
            system_prompt: built_prompt.system_prompt,
            task_prompt: built_prompt.task_prompt,
            model: mode.model,
            tmux: &self.tmux,
            direct_ptys: &direct_ptys_map,
        };

        match spawn_session(&spawn_opts).await {
            Ok(captured_chat_id) => {
                if main_session.agent_chat_id.is_none() {
                    main_session.agent_chat_id = captured_chat_id;
                }
                main_session.lifecycle = SessionLifecycle {
                    state: LifecycleState::Working,
                    reason: None,
                    last_transition_at: now_iso(),
                };
                let ms_clone = main_session.clone();
                let wt_id = worktree_record.id.clone();
                let _ = self
                    .store
                    .mutate_project(&fresh_project.id, move |p| {
                        for w in &mut p.worktrees {
                            if w.id == wt_id {
                                for s in &mut w.sessions {
                                    if s.id == ms_clone.id {
                                        *s = ms_clone.clone();
                                    }
                                }
                            }
                        }
                        Ok(p.clone())
                    })
                    .await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: main_session.id,
                    state: LifecycleState::Working,
                    reason: None,
                });
            }
            Err(e) => {
                main_session.lifecycle = SessionLifecycle {
                    state: LifecycleState::Exited,
                    reason: Some(e.clone()),
                    last_transition_at: now_iso(),
                };
                let ms_clone = main_session.clone();
                let wt_id = worktree_record.id.clone();
                let _ = self
                    .store
                    .mutate_project(&fresh_project.id, move |p| {
                        for w in &mut p.worktrees {
                            if w.id == wt_id {
                                for s in &mut w.sessions {
                                    if s.id == ms_clone.id {
                                        *s = ms_clone.clone();
                                    }
                                }
                            }
                        }
                        Ok(p.clone())
                    })
                    .await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: main_session.id,
                    state: LifecycleState::Exited,
                    reason: Some(e),
                });
            }
        }
    }

    async fn run_direct_agent_spawn(
        &self,
        fresh_project: ProjectRecord,
        mut session_record: SessionRecord,
        mode: Option<vst_types::rest::shared::Mode>,
        prompt: Option<String>,
    ) {
        let Some(mode) = mode else {
            return;
        };
        let plugin = resolve_plugin(mode.cli);
        let built_prompt = build_direct_prompt(&BuildDirectPromptInput {
            project: fresh_project.clone(),
            mode_context: Some(mode.context.clone()),
            user_prompt: prompt,
            rich_chat: false,
        });

        let direct_ptys_map = std::sync::RwLock::new(HashMap::new());
        let spawn_opts = SpawnSessionOpts {
            project: &fresh_project,
            worktree: None,
            session: &session_record,
            plugin: plugin.as_ref(),
            daemon_port: self.daemon_port,
            system_prompt: built_prompt.system_prompt,
            task_prompt: built_prompt.task_prompt,
            model: mode.model,
            tmux: &self.tmux,
            direct_ptys: &direct_ptys_map,
        };

        match spawn_session(&spawn_opts).await {
            Ok(captured_chat_id) => {
                if session_record.agent_chat_id.is_none() {
                    session_record.agent_chat_id = captured_chat_id;
                }
                session_record.lifecycle = SessionLifecycle {
                    state: LifecycleState::Working,
                    reason: None,
                    last_transition_at: now_iso(),
                };
                let s_clone = session_record.clone();
                let _ = self
                    .store
                    .mutate_project(&fresh_project.id, move |p| {
                        for s in &mut p.direct_sessions {
                            if s.id == s_clone.id {
                                *s = s_clone.clone();
                            }
                        }
                        Ok(p.clone())
                    })
                    .await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: session_record.id,
                    state: LifecycleState::Working,
                    reason: None,
                });
            }
            Err(e) => {
                session_record.lifecycle = SessionLifecycle {
                    state: LifecycleState::Exited,
                    reason: Some(e.clone()),
                    last_transition_at: now_iso(),
                };
                let s_clone = session_record.clone();
                let _ = self
                    .store
                    .mutate_project(&fresh_project.id, move |p| {
                        for s in &mut p.direct_sessions {
                            if s.id == s_clone.id {
                                *s = s_clone.clone();
                            }
                        }
                        Ok(p.clone())
                    })
                    .await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: session_record.id,
                    state: LifecycleState::Exited,
                    reason: Some(e),
                });
            }
        }
    }

    // ── 5. PATCH /projects/:id ────────────────────────────────────────────
    pub async fn patch_project(
        &self,
        id: &str,
        body: PatchProjectBody,
    ) -> Result<PatchProjectResult, ProjectRouteError> {
        let current = self
            .store
            .get_project(id)
            .await
            .ok_or_else(|| ProjectRouteError::NotFound(format!("Project '{id}' not found")))?;

        let current_hidden = current.hidden.unwrap_or(false);
        if current_hidden == body.hidden {
            return Ok(PatchProjectResult {
                ok: true,
                project: serialize_project(&current),
            });
        }

        let hidden_val = body.hidden;
        let id_clone = id.to_string();
        let updated = self
            .store
            .mutate_project(&id_clone, move |p| {
                p.hidden = if hidden_val { Some(true) } else { None };
                Ok(p.clone())
            })
            .await
            .map_err(|e| match e {
                StoreError::NotFound(_) => {
                    ProjectRouteError::NotFound(format!("Project '{id}' not found"))
                }
                other => ProjectRouteError::Internal(other.to_string()),
            })?;

        let api_project = serialize_project(&updated);
        if let Ok(val) = serde_json::to_value(&api_project) {
            if let Some(map) = val.as_object() {
                self.broadcaster.send(ServerEvent::ProjectUpdated {
                    project: map.clone(),
                });
            }
        }

        Ok(PatchProjectResult {
            ok: true,
            project: api_project,
        })
    }

    // ── 6. DELETE /projects/:id ───────────────────────────────────────────
    pub async fn delete_project(&self, id: &str) -> Result<(), ProjectRouteError> {
        let project = self
            .store
            .get_project(id)
            .await
            .ok_or_else(|| ProjectRouteError::NotFound(format!("Project '{id}' not found")))?;

        for session in &project.direct_sessions {
            self.release_project_session(session, true).await;
        }

        for wt in &project.worktrees {
            for session in &wt.sessions {
                self.release_project_session(session, true).await;
            }
            let wt_path = self.paths.worktree_path(id, &wt.id);
            let _ = worktree_remove(&project.absolute_path, &wt_path.to_string_lossy()).await;
        }

        let data_dir = self.paths.project_dir(id);
        if !is_safe_project_id(id) {
            return Err(ProjectRouteError::Internal(format!(
                "Refusing to delete data dir for unsafe project id '{id}'"
            )));
        }

        assert_safe_to_delete(&data_dir, self.paths.vst_home(), &project.absolute_path)
            .map_err(ProjectRouteError::Internal)?;

        if let Err(e) = self.store.delete_project(id).await {
            return Err(ProjectRouteError::Internal(format!(
                "Failed to delete project: {e}"
            )));
        }

        let _ = tokio::fs::remove_dir_all(&data_dir).await;

        for session in &project.direct_sessions {
            self.broadcaster.send(ServerEvent::SessionDeleted {
                session_id: session.id.clone(),
            });
        }
        for wt in &project.worktrees {
            for session in &wt.sessions {
                self.broadcaster.send(ServerEvent::SessionDeleted {
                    session_id: session.id.clone(),
                });
            }
            self.broadcaster.send(ServerEvent::WorktreeDeleted {
                worktree_id: wt.id.clone(),
            });
        }
        self.broadcaster.send(ServerEvent::ProjectDeleted {
            project_id: id.to_string(),
        });

        Ok(())
    }

    // ── 7. GET /projects/:projectId/tree ──────────────────────────────────
    pub async fn tree(
        &self,
        project_id: &str,
        sub_path: Option<&str>,
        show_hidden: Option<bool>,
    ) -> Result<Vec<TreeEntry>, ProjectRouteError> {
        let project = self.store.get_project(project_id).await.ok_or_else(|| {
            ProjectRouteError::NotFound(format!("Project '{project_id}' not found"))
        })?;

        let root = Path::new(&project.absolute_path);
        let sub = sub_path.unwrap_or("");
        let target_path = resolve_inside_dir(root, sub)?;

        let hide_dotfiles = show_hidden == Some(false);
        let mut ignore_matcher = build_ignore_matcher(root.to_path_buf());

        let resolved_target = tokio::fs::canonicalize(&target_path)
            .await
            .unwrap_or(target_path.clone());

        let mut read_dir = tokio::fs::read_dir(&target_path)
            .await
            .map_err(|_| ProjectRouteError::NotFound(format!("Path not found: {sub}")))?;

        let mut entries = Vec::new();
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if hide_dotfiles && name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let is_dir = if file_type.is_symlink() {
                tokio::fs::metadata(entry.path())
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            } else {
                file_type.is_dir()
            };

            let entry_resolved = resolved_target.join(&name);
            if ignore_matcher.ignores(&entry_resolved.to_string_lossy(), is_dir) {
                continue;
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
            });
        }

        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    // ── 8. GET /projects/:projectId/file-list ─────────────────────────────
    pub async fn file_list(&self, project_id: &str) -> Result<FileListResult, ProjectRouteError> {
        let project = self.store.get_project(project_id).await.ok_or_else(|| {
            ProjectRouteError::NotFound(format!("Project '{project_id}' not found"))
        })?;

        let res = self
            .file_list
            .list_files(PathBuf::from(&project.absolute_path))
            .await;
        Ok(FileListResult {
            files: res.files,
            truncated: res.truncated,
            source: res.source,
        })
    }

    // ── 9. GET /projects/:projectId/files/* ───────────────────────────────
    pub async fn get_file(
        &self,
        project_id: &str,
        file_path: &str,
    ) -> Result<FileResponse, ProjectRouteError> {
        let project = self.store.get_project(project_id).await.ok_or_else(|| {
            ProjectRouteError::NotFound(format!("Project '{project_id}' not found"))
        })?;

        let root = Path::new(&project.absolute_path);
        let abs_path = resolve_inside_dir(root, file_path)?;

        let meta = tokio::fs::metadata(&abs_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ProjectRouteError::NotFound(format!("File not found: {file_path}"))
            } else {
                ProjectRouteError::unprocessable(e.to_string(), None)
            }
        })?;

        const HARD_LIMIT: u64 = 50 * 1024 * 1024;
        const BINARY_LIMIT: u64 = 1024 * 1024;

        if meta.len() > HARD_LIMIT {
            return Err(ProjectRouteError::unprocessable(
                "File too large (>50MB)",
                Some("size_limit".to_string()),
            ));
        }

        let buf = tokio::fs::read(&abs_path)
            .await
            .map_err(|e| ProjectRouteError::unprocessable(e.to_string(), None))?;

        let ext = abs_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let image_mime = match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "svg" => Some("image/svg+xml"),
            "bmp" => Some("image/bmp"),
            "ico" => Some("image/x-icon"),
            "avif" => Some("image/avif"),
            _ => None,
        };

        if let Some(mime) = image_mime {
            return Ok(FileResponse::Image {
                mime: mime.to_string(),
                content: buf,
            });
        }

        let sample_len = buf.len().min(8192);
        let is_binary = buf[..sample_len].contains(&0);
        if is_binary && meta.len() > BINARY_LIMIT {
            return Err(ProjectRouteError::unprocessable(
                "Binary file (>1MB) — preview unavailable",
                Some("binary".to_string()),
            ));
        }

        let etag = compute_etag(&buf);
        let text = String::from_utf8_lossy(&buf).to_string();

        Ok(FileResponse::Text {
            etag,
            content: text,
        })
    }
}

/// Map internal ProjectRecord to API shape consumed by the web UI.
pub fn serialize_project(p: &ProjectRecord) -> Project {
    Project {
        id: p.id.clone(),
        name: p.id.clone(),
        path: p.absolute_path.clone(),
        prefix: p.prefix.clone(),
        is_git: p.is_git,
        default_branch: p.default_branch.clone(),
        created_at: p.created_at.clone(),
        hidden: p.hidden.unwrap_or(false),
        warning: None,
    }
}

/// Resolve a leading `~` (either exactly `~` or `~/...`) to user home directory.
pub fn expand_tilde(input: &str) -> String {
    let home = home_dir().to_string_lossy().to_string();
    if input == "~" {
        return home;
    }
    if input.starts_with("~/") || input.starts_with(&format!("~{}", std::path::MAIN_SEPARATOR)) {
        let trimmed = &input[2..];
        return PathBuf::from(home)
            .join(trimmed)
            .to_string_lossy()
            .to_string();
    }
    input.to_string()
}

/// Resolve `file_path` inside `root`, rejecting path traversal.
pub fn resolve_inside_dir(root: &Path, file_path: &str) -> Result<PathBuf, ProjectRouteError> {
    let target = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        root.join(file_path)
    };

    let mut normalized = PathBuf::new();
    for comp in target.components() {
        match comp {
            Component::Prefix(p) => normalized.push(p.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(n) => normalized.push(n),
        }
    }

    let mut root_norm = PathBuf::new();
    for comp in root.components() {
        match comp {
            Component::Prefix(p) => root_norm.push(p.as_os_str()),
            Component::RootDir => root_norm.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                root_norm.pop();
            }
            Component::Normal(n) => root_norm.push(n),
        }
    }

    if normalized != root_norm && !normalized.starts_with(&root_norm) {
        return Err(ProjectRouteError::AccessDenied(
            "Access denied: path traversal attempt".to_string(),
        ));
    }

    Ok(normalized)
}

/// Guard against deleting paths outside `~/.vibe-station/projects/` or overlapping protected paths.
pub fn assert_safe_to_delete(
    target: &Path,
    vst_home: &Path,
    protected_path: &str,
) -> Result<(), String> {
    let abs_target = normalize_path(target);
    let abs_home = normalize_path(vst_home);

    if abs_target == abs_home || !abs_target.starts_with(&abs_home) {
        return Err(format!(
            "Refusing to delete '{}' — outside {}",
            abs_target.display(),
            abs_home.display()
        ));
    }

    if !protected_path.is_empty() {
        let abs_prot = normalize_path(Path::new(protected_path));
        if abs_target == abs_prot
            || abs_target.starts_with(&abs_prot)
            || abs_prot.starts_with(&abs_target)
        {
            return Err(format!(
                "Refusing to delete '{}' — overlaps protected path '{}'",
                abs_target.display(),
                abs_prot.display()
            ));
        }
    }

    Ok(())
}

fn normalize_path(p: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Prefix(pr) => normalized.push(pr.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(n) => normalized.push(n),
        }
    }
    normalized
}

fn default_projects_dir() -> String {
    home_dir().join("projects").to_string_lossy().to_string()
}

fn now_iso() -> String {
    format!("{}", ms_now())
}

fn ms_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
