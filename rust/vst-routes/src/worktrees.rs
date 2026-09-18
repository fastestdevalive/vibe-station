//! `routes/worktrees.ts` — worktrees CRUD, tree, files, diff, pr, disk-usage.
//!
//! Ports `daemon/src/routes/worktrees.ts` (1574 LOC, 21 routes) into Rust:
//! - `GET /worktrees` (list worktrees, optional project filter)
//! - `POST /worktrees` (create worktree + main session)
//! - `PATCH /worktrees/:id/pin` (toggle pinned_at)
//! - `PATCH /worktrees/:id/hide` (toggle hidden_at)
//! - `PATCH /worktrees/:id/rename` (cosmetic rename)
//! - `PATCH /worktrees/:id/reorder` (sort order)
//! - `POST /worktrees/:id/done` (release sessions, set agents to done, terminals to exited)
//! - `DELETE /worktrees/:id` (opt-in enforceDone guard, release sessions, purge checkout)
//! - `GET /worktrees/disk-usage` (filesystem stats and worktree directory usages)
//! - `GET /worktrees/:id/tree` (lazy directory listing with ignore filter)
//! - `GET /worktrees/:id/file-list` (flat file listing via ripgrep/walk)
//! - `GET /worktrees/:id/files/*` (serve file contents / images / binary detection / etag)
//! - `GET /worktrees/:id/diff/*` (local / branch / commit diff with etag and size limits)
//! - `GET /worktrees/:id/changed-paths` (local / branch / commit changed paths with numstat)
//! - `GET /worktrees/:id/diffstat` (branch diffstat insertions/deletions)
//! - `GET /worktrees/:id/commits` (commit log with first-parent diffstat and full body)
//! - `GET /worktrees/:id/submodules` (top-level submodules)
//! - `GET /worktrees/:id/pr` (GitHub PR lookup for worktree branch)
//! - `POST /worktrees/:id/open-file` (enqueue file open + broadcast)
//! - `GET /worktrees/:id/pending-file-opens` (get queued file opens)
//! - `DELETE /worktrees/:id/pending-file-opens` (clear queued file opens)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tokio::process::Command;

use vst_agents::json_agent_chat::{start_json_create_turn, StartJsonCreateTurnOpts};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_agents::prompt_builder::{build_prompt, BuildPromptInput};
use vst_agents::resolve_plugin;
use vst_agents::session_runtime::{release_session_runtime, ReleaseOpts};
use vst_git::branch_validator::{branch_exists_in_repo, validate_branch};
use vst_git::direct_pty::PtyKill;
use vst_git::git::{
    branch_exists, get_diff_stat, list_commits, list_submodules, parse_numstat_z, resolve_base_sha,
    resolve_parent_sha, rev_parse, worktree_remove, DiffStat as GitDiffStat, PathNumstat,
};
use vst_git::naming::slugify_prompt;
use vst_git::paths::Paths;
use vst_git::session_id::{generate_session_id, tmux_name_for_session};
use vst_git::worktree_service::{create_worktree_record, CreateWorktreeOpts};
use vst_git::DirectPtyRegistry;
use vst_lifecycle::channel::resolve_channel;
use vst_lifecycle::github::{fetch_prs_for_branches, get_remote_url, resolve_github_remote};
use vst_proc::pty::PtyHandle;
use vst_proc::resolve_use_tmux::resolve_use_tmux;
use vst_proc::tmux::Tmux;
use vst_store::{StoreError, StoreHandle};
use vst_types::domain::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::projects::{TreeEntry, TreeEntryType};
use vst_types::rest::shared::Worktree;
use vst_types::rest::worktrees::{
    ChangedPath, CommitLogEntry, CommitsResult, CreateWorktreeBody, DiffStat, DiskDevice,
    DiskUsage, FileListResult, GutterResult, OpenFileBody, PatchWorktreeResult,
    PatchWorktreeToggleBody, PendingFileOpens, PrInfo, PrInfoState, PrLookupResult,
    RenameWorktreeBody, RenameWorktreeResult, ReorderWorktreeBody, ReorderWorktreeResult,
    SearchFileMatches, SearchMatch, SearchResult, SubmoduleInfo, SubmoduleStatus, SubmodulesResult,
    WorktreeDoneResult, WorktreeUsage,
};
use vst_ws::services::file_list::FileList;
use vst_ws::services::ignore_filter::build_ignore_matcher;
use vst_ws::services::pending_file_opens::PendingFileOpens as PendingFileOpensQueue;

use crate::modes::{find_mode, json_unsupported_cli, resolve_mode_id};
use crate::sessions::{serialize_session, spawn_session, SpawnSessionOpts};

pub const MAX_DIFF_BYTES: usize = 512 * 1024;
pub const COMMIT_SHA_RE: &str = "^[0-9a-fA-F]{7,40}$";

/// Checks if string matches COMMIT_SHA_RE (7-40 hex chars).
pub fn is_valid_commit_sha(s: &str) -> bool {
    let len = s.len();
    (7..=40).contains(&len) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Serialize a `WorktreeRecord` to the REST `Worktree` shape.
pub fn serialize_worktree(project_id: &str, w: &WorktreeRecord) -> Worktree {
    let main_session_id = w.sessions.iter().find(|s| s.is_main).map(|s| s.id.clone());
    Worktree {
        id: w.id.clone(),
        project_id: project_id.to_string(),
        name: w.name.clone(),
        branch: w.branch.clone(),
        branch_is_placeholder: w.branch_is_placeholder.unwrap_or(false),
        base_branch: w.base_branch.clone(),
        base_sha: w.base_sha.clone(),
        created_at: w.created_at.clone(),
        pinned_at: w.pinned_at.clone(),
        hidden_at: w.hidden_at.clone(),
        sort_order: w.sort_order,
        main_session_id,
    }
}

/// Resolve a relative or absolute path inside a worktree root, asserting it stays inside.
pub fn resolve_inside_worktree(
    wt_path: &Path,
    file_path: &str,
) -> Result<PathBuf, WorktreeRouteError> {
    let target = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        wt_path.join(file_path)
    };

    // Normalize path by resolving components
    let mut normalized = PathBuf::new();
    for comp in target.components() {
        match comp {
            std::path::Component::Prefix(p) => normalized.push(p.as_os_str()),
            std::path::Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(n) => normalized.push(n),
        }
    }

    let mut root_norm = PathBuf::new();
    for comp in wt_path.components() {
        match comp {
            std::path::Component::Prefix(p) => root_norm.push(p.as_os_str()),
            std::path::Component::RootDir => root_norm.push(std::path::MAIN_SEPARATOR.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                root_norm.pop();
            }
            std::path::Component::Normal(n) => root_norm.push(n),
        }
    }

    if normalized != root_norm && !normalized.starts_with(&root_norm) {
        return Err(WorktreeRouteError::AccessDenied(
            "Access denied: path traversal attempt".to_string(),
        ));
    }

    Ok(normalized)
}

/// Parse `git status -z --porcelain=v1` stdout.
pub fn parse_porcelain_z(stdout: &str) -> Vec<ChangedPathEntry> {
    let mut entries = Vec::new();
    let records: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < records.len() {
        let rec = records[i];
        if rec.len() < 3 {
            i += 1;
            continue;
        }
        let x = rec.chars().next().unwrap_or(' ');
        let y = rec.chars().nth(1).unwrap_or(' ');
        let path_part = &rec[3..];
        if path_part.is_empty() {
            i += 1;
            continue;
        }
        let status = if x == '?' {
            "?".to_string()
        } else if x != ' ' {
            x.to_string()
        } else {
            y.to_string()
        };
        entries.push(ChangedPathEntry {
            path: path_part.to_string(),
            status,
        });
        if x == 'R' || x == 'C' {
            i += 2;
        } else {
            i += 1;
        }
    }
    entries
}

/// Parse `git diff -z --name-status <mergeBase>` stdout.
pub fn parse_branch_name_status(stdout: &str) -> Vec<ChangedPathEntry> {
    let mut result = Vec::new();
    let tokens: Vec<&str> = stdout.split('\0').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < tokens.len() {
        let status_token = tokens[i];
        let status_char = status_token.chars().next();
        let Some(status_char) = status_char else {
            i += 1;
            continue;
        };
        if status_char == 'R' || status_char == 'C' {
            if let Some(&new_path) = tokens.get(i + 2) {
                result.push(ChangedPathEntry {
                    path: new_path.to_string(),
                    status: if status_char == 'C' {
                        "M".to_string()
                    } else {
                        "R".to_string()
                    },
                });
            }
            i += 3;
        } else {
            if let Some(&path_part) = tokens.get(i + 1) {
                let mapped = match status_char {
                    'T' | 'U' => "M".to_string(),
                    c => c.to_string(),
                };
                result.push(ChangedPathEntry {
                    path: path_part.to_string(),
                    status: mapped,
                });
            }
            i += 2;
        }
    }
    result
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChangedPathEntry {
    pub path: String,
    pub status: String,
}

pub fn merge_numstat(
    entries: Vec<ChangedPathEntry>,
    numstat: HashMap<String, PathNumstat>,
) -> Vec<ChangedPath> {
    entries
        .into_iter()
        .map(|entry| {
            let stat = numstat.get(&entry.path);
            let (insertions, deletions) = match stat {
                Some(s) => (
                    s.insertions.map(|v| v as i64),
                    s.deletions.map(|v| v as i64),
                ),
                None => (None, None),
            };
            ChangedPath {
                path: entry.path,
                status: entry.status,
                insertions,
                deletions,
            }
        })
        .collect()
}

pub async fn run_numstat_cmd(wt_path: &Path, diff_args: &[&str]) -> HashMap<String, PathNumstat> {
    let mut cmd = Command::new("git");
    cmd.arg("diff")
        .arg("--numstat")
        .arg("-z")
        .args(diff_args)
        .current_dir(wt_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return HashMap::new(),
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return HashMap::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_numstat_z(&stdout)
}

pub async fn untracked_numstat_cmd(wt_path: &Path, rel_path: &str) -> PathNumstat {
    let mut cmd = Command::new("git");
    cmd.args([
        "diff",
        "--no-index",
        "--numstat",
        "-z",
        "--",
        "/dev/null",
        rel_path,
    ])
    .current_dir(wt_path)
    .env("GIT_TERMINAL_PROMPT", "0");
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => {
            return PathNumstat {
                insertions: None,
                deletions: None,
            }
        }
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return PathNumstat {
            insertions: None,
            deletions: None,
        };
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_numstat_z(&stdout);
    parsed.get(rel_path).cloned().unwrap_or(PathNumstat {
        insertions: None,
        deletions: None,
    })
}

/// Compute ETag header string: `"\"hex\""`
pub fn compute_etag(content: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    let hex = format!("{:016x}", hasher.finish());
    format!("\"{hex}\"")
}

/// Helper to wrap PtyHandle for PtyKill
struct WorktreePtyHandleKill(PtyHandle);
impl PtyKill for WorktreePtyHandleKill {
    fn kill(&self) {
        self.0.kill();
    }
}

/// Worktree route errors mapped to HTTP status codes.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeRouteError {
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Worktree '{0}' not found")]
    NotFound(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Access denied: {0}")]
    AccessDenied(String),
    #[error("Unprocessable entity: {0}")]
    Unprocessable(String),
    #[error("Worktree not done: {sessions:?}")]
    WorktreeNotDone { sessions: Vec<String> },
    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("Internal server error: {0}")]
    Internal(String),
}

/// WorktreeRoutes handle providing all 21 route implementations.
#[derive(Clone)]
pub struct WorktreeRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    pub direct_ptys: Arc<std::sync::RwLock<HashMap<String, PtyHandle>>>,
    pub tmux: Tmux,
    pub daemon_port: u16,
    pub pending_file_opens: PendingFileOpensQueue,
    pub file_list: Arc<FileList>,
    pub paths: Paths,
}

impl WorktreeRoutes {
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
            pending_file_opens: PendingFileOpensQueue::new(),
            file_list: Arc::new(FileList::new()),
            paths: Paths::default(),
        }
    }

    fn build_direct_pty_registry(&self) -> DirectPtyRegistry {
        let reg = DirectPtyRegistry::new();
        for (sid, handle) in self.direct_ptys.read().unwrap().iter() {
            reg.insert(sid.clone(), Arc::new(WorktreePtyHandleKill(handle.clone())));
        }
        reg
    }

    async fn release_worktree_session(&self, session: &SessionRecord, clear_attachments: bool) {
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

    // --- 1. GET /worktrees?project=:id ---
    pub async fn list_worktrees(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<Worktree>, WorktreeRouteError> {
        if let Some(pid) = project_id {
            let project = self.store.get_project(pid).await.ok_or_else(|| {
                WorktreeRouteError::NotFound(format!("Project '{pid}' not found"))
            })?;
            return Ok(project
                .worktrees
                .iter()
                .map(|w| serialize_worktree(&project.id, w))
                .collect());
        }

        let all = self.store.get_all_projects().await;
        let worktrees = all
            .into_iter()
            .flat_map(|p| {
                let pid = p.id.clone();
                p.worktrees
                    .into_iter()
                    .map(move |w| serialize_worktree(&pid, &w))
            })
            .collect();
        Ok(worktrees)
    }

    // --- 2. POST /worktrees ---
    pub async fn create_worktree(
        &self,
        body: CreateWorktreeBody,
    ) -> Result<Worktree, WorktreeRouteError> {
        let project_id = body.project_id.trim();
        if project_id.is_empty() {
            return Err(WorktreeRouteError::Validation(
                "projectId required".to_string(),
            ));
        }
        let mode_id_input = body.mode_id.trim();
        if mode_id_input.is_empty() {
            return Err(WorktreeRouteError::Validation(
                "modeId required".to_string(),
            ));
        }

        let branch_input = body
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let channel = body.channel.unwrap_or_else(|| match body.use_tmux {
            None => Channel::Json,
            Some(use_tmux) => resolve_channel(resolve_use_tmux(Some(use_tmux)), false),
        });
        let is_json = channel == Channel::Json;
        let use_tmux = channel == Channel::Tmux;

        let mode_id = resolve_mode_id(mode_id_input).ok_or_else(|| {
            WorktreeRouteError::Validation(format!("Mode '{mode_id_input}' not found"))
        })?;

        if is_json {
            if let Some(cli) = json_unsupported_cli(&mode_id) {
                let name = match cli {
                    vst_types::CliId::Claude => "claude",
                    vst_types::CliId::Cursor => "cursor",
                    vst_types::CliId::Opencode => "opencode",
                    vst_types::CliId::Agy => "agy",
                };
                return Err(WorktreeRouteError::Validation(format!(
                    "{name} does not support JSON chat mode"
                )));
            }
        }

        let project = self.store.get_project(project_id).await.ok_or_else(|| {
            WorktreeRouteError::NotFound(format!("Project '{project_id}' not found"))
        })?;

        if !project.is_git {
            return Err(WorktreeRouteError::Validation(
                "Worktrees require a git repository. Use direct sessions for non-git projects."
                    .to_string(),
            ));
        }

        if let Some(ref br) = branch_input {
            let valid = validate_branch(br);
            if !valid.ok {
                return Err(WorktreeRouteError::Validation(
                    valid
                        .reason
                        .unwrap_or_else(|| "Invalid branch name".to_string()),
                ));
            }
            if branch_exists_in_repo(&project.absolute_path, br).await {
                return Err(WorktreeRouteError::Conflict(format!(
                    "Branch '{br}' already exists. Pick a different name."
                )));
            }
        }

        let base_branch = match body.base_branch {
            Some(b) if !b.trim().is_empty() => b.trim().to_string(),
            _ => project
                .default_branch
                .clone()
                .unwrap_or_else(|| "main".to_string()),
        };

        if !branch_exists(&project.absolute_path, &base_branch).await {
            // Best effort fetch
            let _ = self
                .fetch_origin(&project.absolute_path, &base_branch)
                .await;
            if !branch_exists(&project.absolute_path, &base_branch).await {
                return Err(WorktreeRouteError::Validation(format!(
                    "Base branch '{base_branch}' not found locally and could not be fetched from origin."
                )));
            }
        }

        let explicit_name = body
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let heuristic_name = if explicit_name.is_none() {
            body.prompt
                .as_deref()
                .map(slugify_prompt)
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        let wt_name = explicit_name.clone().or(heuristic_name);

        let prompt_clone = body.prompt.clone();
        let mode_id_clone = mode_id.clone();
        let source_agent_id = body.source_agent_id.clone();
        let project_id_clone = project.id.clone();
        let paths_clone = self.paths.clone();

        let created_worktree = create_worktree_record(
            &self.store,
            &self.paths,
            CreateWorktreeOpts {
                project: project.clone(),
                branch: branch_input,
                base_branch,
                prompt: body.prompt.clone(),
                name: wt_name.clone(),
                build_sessions: Box::new(move |wt_id| {
                    let main_session_id = generate_session_id(wt_id, SessionType::Agent);
                    let main_tmux_name = if use_tmux {
                        tmux_name_for_session(&main_session_id)
                    } else {
                        format!("__direct__-{main_session_id}")
                    };
                    let (name, name_source) = if let Some(ref n) = wt_name {
                        (
                            Some(n.clone()),
                            Some(if explicit_name.is_some() {
                                vst_types::SessionNameSource::User
                            } else {
                                vst_types::SessionNameSource::Auto
                            }),
                        )
                    } else {
                        (None, None)
                    };
                    let transcript_ref = if is_json {
                        Some(vst_types::TranscriptRef {
                            kind: vst_types::TranscriptKind::VstJson,
                            path: Some(format!(
                                "{}/messages.jsonl",
                                paths_clone
                                    .session_data_dir(&project_id_clone, wt_id, &main_session_id)
                                    .display()
                            )),
                        })
                    } else {
                        None
                    };
                    let main_session = SessionRecord {
                        id: main_session_id,
                        worktree_id: Some(wt_id.to_string()),
                        project_id: project_id_clone.clone(),
                        is_main: true,
                        sort_order: 0.0,
                        r#type: SessionType::Agent,
                        mode_id: Some(mode_id_clone.clone()),
                        name,
                        name_source,
                        tmux_name: main_tmux_name,
                        use_tmux,
                        channel: Some(channel),
                        transcript_ref,
                        lifecycle: SessionLifecycle {
                            state: LifecycleState::NotStarted,
                            reason: None,
                            last_transition_at: now_iso(),
                        },
                        agent_chat_id: None,
                        acp_session_id: None,
                        model_override: None,
                        pinned_at: None,
                        initial_prompt: prompt_clone.clone(),
                        draft_prompt: None,
                        draft_config: None,
                        archived_at: None,
                        handoff_summary: None,
                        parent_session_id: source_agent_id.clone(),
                        superseded_by: None,
                        pr: None,
                    };
                    vec![main_session]
                }),
            },
        )
        .await;

        let created_worktree = match created_worktree {
            Ok(w) => w,
            Err(e) => {
                return Err(WorktreeRouteError::Internal(format!(
                    "Failed to create worktree: {e}"
                )))
            }
        };

        let wt_id = created_worktree.id.clone();
        let main_session = created_worktree.sessions[0].clone();

        let api_worktree_early = serialize_worktree(&project.id, &created_worktree);
        if let Ok(val) = serde_json::to_value(&api_worktree_early) {
            if let Some(map) = val.as_object() {
                self.broadcaster.send(ServerEvent::WorktreeCreated {
                    worktree: map.clone(),
                });
            }
        }

        let main_session_serialized = serialize_session(Some(&wt_id), &project.id, &main_session);
        self.broadcaster.send(ServerEvent::SessionCreated {
            session_id: main_session.id.clone(),
            project_id: Some(project.id.clone()),
            worktree_id: Some(wt_id.clone()),
            session_type: "agent".to_string(),
            mode: Some(mode_id.clone()),
            snapshot: Some((&main_session_serialized).into()),
            parent_session_id: main_session.parent_session_id.clone(),
        });

        if is_json {
            if !body.skip_auto_turn.unwrap_or(false) {
                let routes = self.clone();
                let main_sid = main_session.id.clone();
                let prompt_val = body.prompt.clone();
                tokio::spawn(async move {
                    start_json_create_turn(
                        StartJsonCreateTurnOpts {
                            session_id: main_sid,
                            prompt: prompt_val,
                            daemon_port: routes.daemon_port,
                            store: routes.store.clone(),
                            broadcaster: routes.broadcaster.clone(),
                        },
                        &routes.json_registry,
                    )
                    .await;
                });
            }
        } else {
            let routes = self.clone();
            let fresh_project = self.store.get_project(&project.id).await.unwrap_or(project);
            let mode_val = find_mode(&mode_id);
            let wt_rec = created_worktree.clone();
            let main_sess = main_session.clone();
            tokio::spawn(async move {
                routes
                    .run_main_spawn_job(fresh_project, wt_rec, main_sess, mode_val, body.prompt)
                    .await;
            });
        }

        Ok(serialize_worktree(&project_id, &created_worktree))
    }

    async fn run_main_spawn_job(
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
            Ok(()) => {
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

    // --- 3. PATCH /worktrees/:id/pin ---
    pub async fn patch_pin(
        &self,
        wt_id: &str,
        body: PatchWorktreeToggleBody,
    ) -> Result<PatchWorktreeResult, WorktreeRouteError> {
        let pinned = match body.pinned {
            Some(p) => p,
            None => {
                return Err(WorktreeRouteError::Validation(
                    "pinned required".to_string(),
                ))
            }
        };

        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_id_owned = wt_id.to_string();

        let updated_wt = self
            .store
            .mutate_project(&project.id, move |p| {
                let wt = p.worktrees.iter_mut().find(|w| w.id == wt_id_owned);
                let Some(wt) = wt else {
                    return Err(StoreError::Mutation("Worktree not found".to_string()));
                };
                let already_pinned = wt.pinned_at.is_some();
                if already_pinned == pinned {
                    return Ok(p.clone());
                }
                wt.pinned_at = if pinned { Some(now_iso()) } else { None };
                Ok(p.clone())
            })
            .await
            .map_err(|_| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        let wt = updated_wt
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let serialized = serialize_worktree(&project.id, wt);

        self.broadcaster.send(ServerEvent::WorktreeUpdated {
            worktree: serialize_worktree_json(&project.id, wt),
        });

        Ok(PatchWorktreeResult {
            ok: true,
            worktree: serialized,
        })
    }

    // --- 4. PATCH /worktrees/:id/hide ---
    pub async fn patch_hide(
        &self,
        wt_id: &str,
        body: PatchWorktreeToggleBody,
    ) -> Result<PatchWorktreeResult, WorktreeRouteError> {
        let hidden = match body.hidden {
            Some(h) => h,
            None => {
                return Err(WorktreeRouteError::Validation(
                    "hidden required".to_string(),
                ))
            }
        };

        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_id_owned = wt_id.to_string();

        let updated_project = self
            .store
            .mutate_project(&project.id, move |p| {
                let wt = p.worktrees.iter_mut().find(|w| w.id == wt_id_owned);
                let Some(wt) = wt else {
                    return Err(StoreError::Mutation("Worktree not found".to_string()));
                };
                let already_hidden = wt.hidden_at.is_some();
                if already_hidden == hidden {
                    return Ok(p.clone());
                }
                if hidden {
                    wt.pinned_at = None;
                    wt.hidden_at = Some(now_iso());
                } else {
                    wt.hidden_at = None;
                }
                Ok(p.clone())
            })
            .await
            .map_err(|_| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        let wt = updated_project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let serialized = serialize_worktree(&project.id, wt);

        self.broadcaster.send(ServerEvent::WorktreeUpdated {
            worktree: serialize_worktree_json(&project.id, wt),
        });

        Ok(PatchWorktreeResult {
            ok: true,
            worktree: serialized,
        })
    }

    // --- 5. PATCH /worktrees/:id/rename ---
    pub async fn patch_rename(
        &self,
        wt_id: &str,
        body: RenameWorktreeBody,
    ) -> Result<RenameWorktreeResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let trimmed = body.name.trim();
        let value = if trimmed.is_empty() {
            None
        } else {
            let val = if trimmed.len() > 60 {
                &trimmed[..60]
            } else {
                trimmed
            };
            Some(val.to_string())
        };

        let value_clone = value.clone();
        let wt_id_owned = wt_id.to_string();
        let updated_project = self
            .store
            .mutate_project(&project.id, move |p| {
                let wt = p.worktrees.iter_mut().find(|w| w.id == wt_id_owned);
                let Some(wt) = wt else {
                    return Err(StoreError::Mutation("Worktree not found".to_string()));
                };
                wt.name = value_clone.clone();
                Ok(p.clone())
            })
            .await
            .map_err(|_| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        if let Some(wt) = updated_project.worktrees.iter().find(|w| w.id == wt_id) {
            self.broadcaster.send(ServerEvent::WorktreeUpdated {
                worktree: serialize_worktree_json(&project.id, wt),
            });
        }

        Ok(RenameWorktreeResult {
            ok: true,
            name: value,
        })
    }

    // --- 6. PATCH /worktrees/:id/reorder ---
    pub async fn patch_reorder(
        &self,
        wt_id: &str,
        body: ReorderWorktreeBody,
    ) -> Result<ReorderWorktreeResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let value = body.sort_order;
        let wt_id_owned = wt_id.to_string();

        let updated_project = self
            .store
            .mutate_project(&project.id, move |p| {
                let wt = p.worktrees.iter_mut().find(|w| w.id == wt_id_owned);
                let Some(wt) = wt else {
                    return Err(StoreError::Mutation("Worktree not found".to_string()));
                };
                wt.sort_order = value;
                Ok(p.clone())
            })
            .await
            .map_err(|_| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        if let Some(wt) = updated_project.worktrees.iter().find(|w| w.id == wt_id) {
            self.broadcaster.send(ServerEvent::WorktreeUpdated {
                worktree: serialize_worktree_json(&project.id, wt),
            });
        }

        Ok(ReorderWorktreeResult {
            ok: true,
            sort_order: value,
        })
    }

    // --- 7. POST /worktrees/:id/done ---
    pub async fn worktree_done(
        &self,
        wt_id: &str,
    ) -> Result<WorktreeDoneResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        let mut updated = 0;
        let mut terminals_released = 0;

        for session in &worktree.sessions {
            if session.r#type == SessionType::Agent {
                if session.lifecycle.state == LifecycleState::Done {
                    continue;
                }
                self.release_worktree_session(session, false).await;
                let _ = self
                    .store
                    .update_session_lifecycle(
                        &project.id,
                        &session.id,
                        SessionLifecycle {
                            state: LifecycleState::Done,
                            reason: None,
                            last_transition_at: now_iso(),
                        },
                    )
                    .await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: session.id.clone(),
                    state: LifecycleState::Done,
                    reason: None,
                });
                updated += 1;
            } else {
                if session.lifecycle.state == LifecycleState::Exited {
                    continue;
                }
                let _ = self
                    .store
                    .update_session_lifecycle(
                        &project.id,
                        &session.id,
                        SessionLifecycle {
                            state: LifecycleState::Exited,
                            reason: None,
                            last_transition_at: now_iso(),
                        },
                    )
                    .await;
                self.release_worktree_session(session, false).await;
                self.broadcaster.send(ServerEvent::SessionState {
                    session_id: session.id.clone(),
                    state: LifecycleState::Exited,
                    reason: None,
                });
                terminals_released += 1;
            }
        }

        Ok(WorktreeDoneResult {
            ok: true,
            updated,
            terminals_released,
        })
    }

    // --- 8. DELETE /worktrees/:id ---
    pub async fn delete_worktree(
        &self,
        wt_id: &str,
        enforce_done: bool,
    ) -> Result<(), WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        if enforce_done {
            let not_done: Vec<String> = worktree
                .sessions
                .iter()
                .filter(|s| {
                    if s.r#type == SessionType::Agent {
                        s.lifecycle.state != LifecycleState::Done
                    } else {
                        s.lifecycle.state != LifecycleState::Done
                            && s.lifecycle.state != LifecycleState::Exited
                    }
                })
                .map(|s| s.id.clone())
                .collect();

            if !not_done.is_empty() {
                return Err(WorktreeRouteError::WorktreeNotDone { sessions: not_done });
            }
        }

        // Release runtime and remove session directories
        for session in &worktree.sessions {
            self.release_worktree_session(session, true).await;
            let dir = self.paths.session_data_dir(&project.id, wt_id, &session.id);
            let _ = tokio::fs::remove_dir_all(&dir).await;
        }

        // Remove worktree git checkout
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let _ = worktree_remove(&project.absolute_path, &wt_path.to_string_lossy()).await;

        // Remove from manifest
        let wt_id_owned = wt_id.to_string();
        let _ = self
            .store
            .mutate_project(&project.id, move |p| {
                p.worktrees.retain(|w| w.id != wt_id_owned);
                Ok(p.clone())
            })
            .await;

        for session in &worktree.sessions {
            self.broadcaster.send(ServerEvent::SessionDeleted {
                session_id: session.id.clone(),
            });
        }

        self.broadcaster.send(ServerEvent::WorktreeDeleted {
            worktree_id: wt_id.to_string(),
        });

        Ok(())
    }

    // --- 9. GET /worktrees/disk-usage ---
    pub async fn disk_usage(&self) -> Result<DiskUsage, WorktreeRouteError> {
        let home = self.paths.vst_home().clone();
        let home_str = home.to_string_lossy().to_string();

        let device = get_fs_stat(&home_str).await?;

        let all_projects = self.store.get_all_projects().await;
        let mut worktrees = Vec::new();

        for p in all_projects {
            for w in p.worktrees {
                let checkout_path = self.paths.worktree_path(&p.id, &w.id);
                let session_data_parent = self
                    .paths
                    .project_dir(&p.id)
                    .join("session-data")
                    .join(&w.id);

                let (cb, sb) = tokio::join!(
                    dir_disk_usage(&checkout_path),
                    dir_disk_usage(&session_data_parent),
                );

                worktrees.push(WorktreeUsage {
                    id: w.id,
                    disk_bytes: cb + sb,
                });
            }
        }

        Ok(DiskUsage { device, worktrees })
    }

    // --- 10. GET /worktrees/:id/tree ---
    pub async fn tree(
        &self,
        wt_id: &str,
        sub_path: Option<&str>,
        show_hidden: Option<bool>,
    ) -> Result<Vec<TreeEntry>, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let sub = sub_path.unwrap_or("");
        let target_path = resolve_inside_worktree(&wt_path, sub)?;

        let hide_dotfiles = show_hidden == Some(false);
        let mut ignore_matcher = build_ignore_matcher(wt_path.clone());

        let resolved_target = tokio::fs::canonicalize(&target_path)
            .await
            .unwrap_or(target_path.clone());

        let mut read_dir = tokio::fs::read_dir(&target_path)
            .await
            .map_err(|_| WorktreeRouteError::NotFound(format!("Path not found: {sub}")))?;

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

    // --- 11. GET /worktrees/:id/file-list ---
    pub async fn file_list(&self, wt_id: &str) -> Result<FileListResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let res = self.file_list.list_files(wt_path).await;
        Ok(FileListResult {
            files: res.files,
            truncated: res.truncated,
            source: res.source,
        })
    }

    // --- 11b. GET /worktrees/:id/search ---
    pub async fn search(
        &self,
        wt_id: &str,
        q: &str,
        re: bool,
        case: bool,
        word: bool,
        glob: Option<&str>,
        limit: Option<usize>,
    ) -> Result<SearchResult, WorktreeRouteError> {
        if q.is_empty() {
            return Err(WorktreeRouteError::Validation("q is required".into()));
        }

        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let limit = limit.unwrap_or(2000);

        let mut argv = vec![
            "--json".to_string(),
            "--hidden".to_string(),
            "--glob".to_string(),
            "!.git".to_string(),
            "--glob".to_string(),
            "!.git/**".to_string(),
        ];

        if !re {
            argv.push("--fixed-strings".into());
        }
        if case {
            argv.push("--case-sensitive".into());
        } else {
            argv.push("--ignore-case".into());
        }
        if word {
            argv.push("--word-regexp".into());
        }
        if let Some(g) = glob {
            argv.push("--glob".into());
            argv.push(g.to_string());
        }
        argv.push("--".into());
        argv.push(q.to_string());

        let mut child = Command::new("rg")
            .args(&argv)
            .current_dir(&wt_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    WorktreeRouteError::ServiceUnavailable("ripgrep_unavailable".into())
                } else {
                    WorktreeRouteError::Internal(format!("Failed to spawn rg: {e}"))
                }
            })?;

        let stdout = child.stdout.take().ok_or_else(|| {
            WorktreeRouteError::Internal("Failed to capture rg stdout".into())
        })?;

        let reader = tokio::io::BufReader::new(stdout);
        use tokio::io::AsyncBufReadExt;
        let mut lines = reader.lines();

        // Group matches by file path, preserving first-seen order.
        let mut files: Vec<SearchFileMatches> = Vec::new();
        let mut file_index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut total_matches: usize = 0;
        let mut truncated = false;

        while let Some(line) = lines.next_line().await.unwrap_or(None) {
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if parsed.get("type").and_then(|t| t.as_str()) != Some("match") {
                continue;
            }

            let data = match parsed.get("data") {
                Some(d) => d,
                None => continue,
            };

            let path = data
                .pointer("/path/text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let line_number = data
                .pointer("/line_number")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let lines_text = data
                .pointer("/lines/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let submatches = match data.get("submatches").and_then(|v| v.as_array()) {
                Some(a) => a,
                None => continue,
            };

            for sm in submatches {
                let start = sm.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let end = sm.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

                let (pre, mid, post) = truncate_snippet(lines_text, start, end);

                let m = SearchMatch {
                    line: line_number,
                    pre,
                    mid,
                    post,
                };

                let idx = if let Some(&i) = file_index.get(&path) {
                    i
                } else {
                    let i = files.len();
                    file_index.insert(path.clone(), i);
                    files.push(SearchFileMatches {
                        path: path.clone(),
                        matches: Vec::new(),
                    });
                    i
                };
                files[idx].matches.push(m);
                total_matches += 1;

                if total_matches >= limit {
                    truncated = true;
                    break;
                }
            }

            if truncated {
                break;
            }
        }

        // Kill the child if we stopped early (truncated) or just let it finish.
        let _ = child.kill().await;
        let _ = child.wait().await;

        Ok(SearchResult {
            files,
            truncated,
            total_matches,
        })
    }

    // --- 12. GET /worktrees/:id/files/* ---
    pub async fn get_file(
        &self,
        wt_id: &str,
        file_path: &str,
    ) -> Result<FileResponse, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let abs_path = resolve_inside_worktree(&wt_path, file_path)?;

        let meta = tokio::fs::metadata(&abs_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WorktreeRouteError::NotFound(format!("File not found: {file_path}"))
            } else {
                WorktreeRouteError::Unprocessable(e.to_string())
            }
        })?;

        const HARD_LIMIT: u64 = 50 * 1024 * 1024;
        const BINARY_LIMIT: u64 = 1024 * 1024;

        if meta.len() > HARD_LIMIT {
            return Err(WorktreeRouteError::Unprocessable(
                "File too large (>50MB)".to_string(),
            ));
        }

        let buf = tokio::fs::read(&abs_path)
            .await
            .map_err(|e| WorktreeRouteError::Unprocessable(e.to_string()))?;

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
            _ => None,
        };

        if let Some(mime) = image_mime {
            return Ok(FileResponse::Image {
                mime: mime.to_string(),
                content: buf,
            });
        }

        // Binary detection: check null byte in first 8KB
        let sample_len = buf.len().min(8192);
        let is_binary = buf[..sample_len].contains(&0);
        if is_binary && meta.len() > BINARY_LIMIT {
            return Err(WorktreeRouteError::Unprocessable(
                "Binary file (>1MB) — preview unavailable".to_string(),
            ));
        }

        let etag = compute_etag(&buf);
        let text = String::from_utf8_lossy(&buf).to_string();

        Ok(FileResponse::Text {
            etag,
            content: text,
        })
    }

    // --- 13. GET /worktrees/:id/diff/* ---
    pub async fn diff(
        &self,
        wt_id: &str,
        file_path: &str,
        scope: Option<&str>,
        sha: Option<&str>,
    ) -> Result<DiffResponse, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let scope = scope.unwrap_or("local");

        let mut cmd = Command::new("git");
        cmd.arg("-c")
            .arg("color.diff=false")
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("diff");

        match scope {
            "branch" => {
                let base_sha = resolve_base_sha(
                    &wt_path.to_string_lossy(),
                    Some(&worktree.base_branch),
                    Some(&worktree.base_sha),
                )
                .await
                .map_err(|e| WorktreeRouteError::Internal(e.to_string()))?
                .ok_or_else(|| {
                    WorktreeRouteError::Unprocessable(
                        "Could not resolve base branch fork point".to_string(),
                    )
                })?;
                cmd.arg(base_sha).arg("--").arg(file_path);
            }
            "commit" => {
                let sha = sha.ok_or_else(|| {
                    WorktreeRouteError::Unprocessable("Could not resolve commit sha".to_string())
                })?;
                if !is_valid_commit_sha(sha) {
                    return Err(WorktreeRouteError::Unprocessable(
                        "Could not resolve commit sha".to_string(),
                    ));
                }
                let wt_str = wt_path.to_string_lossy().to_string();
                let resolved_sha = rev_parse(&wt_str, &format!("{sha}^{{commit}}"))
                    .await
                    .map_err(|_| {
                        WorktreeRouteError::Unprocessable(
                            "Could not resolve commit sha".to_string(),
                        )
                    })?;
                let parent_sha =
                    resolve_parent_sha(&wt_str, &resolved_sha)
                        .await
                        .map_err(|_| {
                            WorktreeRouteError::Unprocessable(
                                "Could not resolve commit sha".to_string(),
                            )
                        })?;
                cmd.arg(parent_sha)
                    .arg(resolved_sha)
                    .arg("--")
                    .arg(file_path);
            }
            _ => {
                cmd.arg("HEAD").arg("--").arg(file_path);
            }
        }

        cmd.current_dir(&wt_path).env("GIT_TERMINAL_PROMPT", "0");
        let output = cmd
            .output()
            .await
            .map_err(|e| WorktreeRouteError::Internal(format!("git diff failed: {e}")))?;

        if !output.status.success() && output.status.code() != Some(1) {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(WorktreeRouteError::Internal(if stderr.is_empty() {
                format!("git diff exited with status {:?}", output.status.code())
            } else {
                stderr
            }));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if stdout.contains("Binary files ") && stdout.contains(" differ") {
            return Err(WorktreeRouteError::Unprocessable(
                "Binary file diff is not supported".to_string(),
            ));
        }
        if stdout.len() > MAX_DIFF_BYTES {
            return Err(WorktreeRouteError::Unprocessable(
                "Diff too large to display".to_string(),
            ));
        }

        let etag = compute_etag(stdout.as_bytes());
        Ok(DiffResponse {
            etag,
            content: stdout,
        })
    }

    // --- 14. GET /worktrees/:id/changed-paths ---
    pub async fn changed_paths(
        &self,
        wt_id: &str,
        scope: Option<&str>,
        sha: Option<&str>,
    ) -> Result<Vec<ChangedPath>, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let scope = scope.unwrap_or("local");

        if scope == "commit" {
            let sha = sha.ok_or_else(|| {
                WorktreeRouteError::Unprocessable("Could not resolve commit sha".to_string())
            })?;
            if !is_valid_commit_sha(sha) {
                return Err(WorktreeRouteError::Unprocessable(
                    "Could not resolve commit sha".to_string(),
                ));
            }
            let wt_str = wt_path.to_string_lossy().to_string();
            let resolved_sha = rev_parse(&wt_str, &format!("{sha}^{{commit}}"))
                .await
                .map_err(|_| {
                    WorktreeRouteError::Unprocessable("Could not resolve commit sha".to_string())
                })?;
            let parent_sha = resolve_parent_sha(&wt_str, &resolved_sha)
                .await
                .map_err(|_| {
                    WorktreeRouteError::Unprocessable("Could not resolve commit sha".to_string())
                })?;

            let mut cmd = Command::new("git");
            cmd.args([
                "-c",
                "core.quotepath=false",
                "diff",
                "-z",
                "--name-status",
                &parent_sha,
                &resolved_sha,
            ])
            .current_dir(&wt_path)
            .env("GIT_TERMINAL_PROMPT", "0");
            let output = cmd.output().await.map_err(|e| {
                WorktreeRouteError::Internal(format!("git diff --name-status failed: {e}"))
            })?;
            if !output.status.success() && output.status.code() != Some(1) {
                return Err(WorktreeRouteError::Internal(
                    "git diff --name-status failed".to_string(),
                ));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let entries = parse_branch_name_status(&stdout);
            let numstat = run_numstat_cmd(&wt_path, &[&parent_sha, &resolved_sha]).await;
            return Ok(merge_numstat(entries, numstat));
        }

        if scope == "branch" {
            let wt_str = wt_path.to_string_lossy().to_string();
            let branch_base_sha = resolve_base_sha(
                &wt_str,
                Some(&worktree.base_branch),
                Some(&worktree.base_sha),
            )
            .await
            .map_err(|e| WorktreeRouteError::Internal(e.to_string()))?
            .ok_or_else(|| {
                WorktreeRouteError::Unprocessable(
                    "Could not resolve base branch fork point".to_string(),
                )
            })?;

            let mut cmd = Command::new("git");
            cmd.args([
                "-c",
                "core.quotepath=false",
                "diff",
                "-z",
                "--name-status",
                &branch_base_sha,
            ])
            .current_dir(&wt_path)
            .env("GIT_TERMINAL_PROMPT", "0");
            let output = cmd.output().await.map_err(|e| {
                WorktreeRouteError::Internal(format!("git diff --name-status failed: {e}"))
            })?;
            if !output.status.success() && output.status.code() != Some(1) {
                return Err(WorktreeRouteError::Internal(
                    "git diff --name-status failed".to_string(),
                ));
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let entries = parse_branch_name_status(&stdout);
            let numstat = run_numstat_cmd(&wt_path, &[&branch_base_sha]).await;
            return Ok(merge_numstat(entries, numstat));
        }

        // Local scope: git status -z -uall + git diff --numstat HEAD + untrackedNumstat
        let mut cmd = Command::new("git");
        cmd.args(["status", "--porcelain=v1", "-z", "-uall"])
            .current_dir(&wt_path)
            .env("GIT_TERMINAL_PROMPT", "0");
        let output = cmd
            .output()
            .await
            .map_err(|e| WorktreeRouteError::Internal(format!("git status failed: {e}")))?;
        if !output.status.success() {
            return Err(WorktreeRouteError::Internal(
                "git status failed".to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let entries = parse_porcelain_z(&stdout);
        let mut numstat = run_numstat_cmd(&wt_path, &["HEAD"]).await;

        for entry in &entries {
            if entry.status == "?" && !numstat.contains_key(&entry.path) {
                let stat = untracked_numstat_cmd(&wt_path, &entry.path).await;
                numstat.insert(entry.path.clone(), stat);
            }
        }

        Ok(merge_numstat(entries, numstat))
    }

    // --- 15. GET /worktrees/:id/diffstat?scope=branch ---
    pub async fn diffstat(
        &self,
        wt_id: &str,
        scope: Option<&str>,
    ) -> Result<DiffStat, WorktreeRouteError> {
        let scope = scope.unwrap_or("branch");
        if scope != "branch" {
            return Err(WorktreeRouteError::Validation(
                "Unsupported scope; only 'branch' is supported".to_string(),
            ));
        }

        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let wt_str = wt_path.to_string_lossy().to_string();

        let base_sha = resolve_base_sha(
            &wt_str,
            Some(&worktree.base_branch),
            Some(&worktree.base_sha),
        )
        .await
        .map_err(|e| WorktreeRouteError::Internal(e.to_string()))?
        .ok_or_else(|| {
            WorktreeRouteError::Unprocessable(
                "Could not resolve base branch fork point".to_string(),
            )
        })?;

        let stat: GitDiffStat = get_diff_stat(&wt_str, &base_sha)
            .await
            .map_err(|e| WorktreeRouteError::Internal(e.to_string()))?;

        Ok(DiffStat {
            insertions: stat.insertions as i64,
            deletions: stat.deletions as i64,
        })
    }

    // --- 16. GET /worktrees/:id/commits?limit=<n> ---
    pub async fn commits(
        &self,
        wt_id: &str,
        limit: Option<usize>,
    ) -> Result<CommitsResult, WorktreeRouteError> {
        let limit = limit.unwrap_or(200).clamp(1, 1000);
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let wt_str = wt_path.to_string_lossy().to_string();

        if !worktree.base_branch.is_empty() {
            let _ = self
                .fetch_origin(&project.absolute_path, &worktree.base_branch)
                .await;
        }

        let base_sha = resolve_base_sha(
            &wt_str,
            Some(&worktree.base_branch),
            Some(&worktree.base_sha),
        )
        .await
        .ok()
        .flatten();

        let commits = list_commits(&wt_str, limit, base_sha.as_deref())
            .await
            .map_err(|e| WorktreeRouteError::Internal(e.to_string()))?;

        let mapped = commits
            .into_iter()
            .map(|c| CommitLogEntry {
                sha: c.sha,
                short_sha: c.short_sha,
                author_name: c.author_name,
                author_email: c.author_email,
                date: c.date,
                subject: c.subject,
                body: c.body,
                insertions: c.insertions as i64,
                deletions: c.deletions as i64,
                has_binary_changes: c.has_binary_changes,
                is_on_branch: c.is_on_branch,
            })
            .collect();

        Ok(CommitsResult { commits: mapped })
    }

    // --- 17. GET /worktrees/:id/submodules ---
    pub async fn submodules(&self, wt_id: &str) -> Result<SubmodulesResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let wt_str = wt_path.to_string_lossy().to_string();

        let subs = list_submodules(&wt_str).await;
        let mapped = subs
            .into_iter()
            .map(|s| SubmoduleInfo {
                path: s.path,
                sha: s.sha,
                short_sha: s.short_sha,
                branch: s.branch,
                subject: s.subject,
                status: match s.status {
                    vst_git::git::SubmoduleStatus::Clean => SubmoduleStatus::Clean,
                    vst_git::git::SubmoduleStatus::Modified => SubmoduleStatus::Modified,
                    vst_git::git::SubmoduleStatus::OutOfDate => SubmoduleStatus::OutOfDate,
                    vst_git::git::SubmoduleStatus::Uninitialized => SubmoduleStatus::Uninitialized,
                },
            })
            .collect();

        Ok(SubmodulesResult { submodules: mapped })
    }

    // --- 18. GET /worktrees/:id/pr ---
    pub async fn pr(&self, wt_id: &str) -> Result<PrLookupResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let worktree = project
            .worktrees
            .iter()
            .find(|w| w.id == wt_id)
            .ok_or_else(|| WorktreeRouteError::NotFound(format!("Worktree '{wt_id}' not found")))?;

        let remote_url = match get_remote_url(Path::new(&project.absolute_path)).await {
            Ok(url) => url,
            Err(_) => return Ok(PrLookupResult::NotGithub),
        };

        let gh = match resolve_github_remote(&remote_url) {
            Some(gh) => gh,
            None => return Ok(PrLookupResult::NotGithub),
        };

        let branch = worktree.branch.clone();
        let res_map = match fetch_prs_for_branches(&gh, std::slice::from_ref(&branch)).await {
            Ok(m) => m,
            Err(e) => {
                return Err(WorktreeRouteError::ServiceUnavailable(format!(
                    "GitHub API error: {e}"
                )));
            }
        };

        let res = res_map.get(&branch);
        match res {
            Some(vst_lifecycle::github::PrLookupResult::NoCredentials { error }) => {
                Err(WorktreeRouteError::ServiceUnavailable(error.clone()))
            }
            Some(vst_lifecycle::github::PrLookupResult::Error { error }) => {
                Err(WorktreeRouteError::ServiceUnavailable(error.clone()))
            }
            Some(vst_lifecycle::github::PrLookupResult::NoPr) => Ok(PrLookupResult::NoPr),
            Some(vst_lifecycle::github::PrLookupResult::Pr(pr_data)) => Ok(PrLookupResult::Pr {
                pr: PrInfo {
                    number: pr_data.number,
                    url: pr_data.url.clone(),
                    title: pr_data.title.clone(),
                    state: if pr_data.state == "open" {
                        PrInfoState::Open
                    } else {
                        PrInfoState::Closed
                    },
                    merged: pr_data.merged,
                    draft: pr_data.draft,
                    author: None,
                },
            }),
            None => Ok(PrLookupResult::NoPr),
        }
    }

    // --- 19. POST /worktrees/:id/open-file ---
    pub async fn open_file(
        &self,
        wt_id: &str,
        body: OpenFileBody,
    ) -> Result<(), WorktreeRouteError> {
        let path_str = body.path.trim();
        if path_str.is_empty() {
            return Err(WorktreeRouteError::Validation("path required".to_string()));
        }

        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let abs = resolve_inside_worktree(&wt_path, path_str)?;

        let rel = abs
            .strip_prefix(&wt_path)
            .map_err(|_| {
                WorktreeRouteError::Unprocessable("path outside worktree root".to_string())
            })?
            .to_string_lossy()
            .to_string();

        self.pending_file_opens.append(wt_id, &rel);
        self.broadcaster.send(ServerEvent::FileOpen {
            worktree_id: wt_id.to_string(),
            path: rel,
        });

        Ok(())
    }

    // --- 20. GET /worktrees/:id/pending-file-opens ---
    pub async fn get_pending_file_opens(
        &self,
        wt_id: &str,
    ) -> Result<PendingFileOpens, WorktreeRouteError> {
        let _ = self.find_project_for_worktree(wt_id).await?;
        let paths = self.pending_file_opens.get(wt_id);
        Ok(PendingFileOpens { paths })
    }

    // --- 21. DELETE /worktrees/:id/pending-file-opens ---
    pub async fn delete_pending_file_opens(&self, wt_id: &str) -> Result<(), WorktreeRouteError> {
        let _ = self.find_project_for_worktree(wt_id).await?;
        self.pending_file_opens.clear(wt_id);
        Ok(())
    }

    // --- 22. GET /worktrees/:id/gutter/* ---
    pub async fn gutter(
        &self,
        wt_id: &str,
        file_path: &str,
    ) -> Result<GutterResult, WorktreeRouteError> {
        let project = self.find_project_for_worktree(wt_id).await?;
        let wt_path = self.paths.worktree_path(&project.id, wt_id);
        let abs_path = resolve_inside_worktree(&wt_path, file_path)?;

        // Compute relative path for git commands
        let rel_path = abs_path
            .strip_prefix(&wt_path)
            .map_err(|_| {
                WorktreeRouteError::Unprocessable("path outside worktree root".to_string())
            })?
            .to_string_lossy()
            .to_string();

        // Check if file is tracked with git ls-files --error-unmatch
        let check_tracked = Command::new("git")
            .args(["ls-files", "--error-unmatch", "--", &rel_path])
            .current_dir(&wt_path)
            .output()
            .await
            .map_err(|e| WorktreeRouteError::Internal(format!("Failed to run git ls-files: {e}")))?;

        if !check_tracked.status.success() {
            // File is untracked — read its contents
            match tokio::fs::read(&abs_path).await {
                Ok(content) => {
                    // Try to decode as UTF-8
                    if let Ok(text) = String::from_utf8(content) {
                        let line_count = text.lines().count() as u32;
                        if line_count > 0 {
                            let added = (1..=line_count).collect();
                            return Ok(GutterResult {
                                added,
                                deleted: vec![],
                                modified: vec![],
                            });
                        } else {
                            // Empty file
                            return Ok(GutterResult::default());
                        }
                    } else {
                        // Binary file — return empty gutter
                        return Ok(GutterResult::default());
                    }
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        return Err(WorktreeRouteError::NotFound(format!(
                            "File not found: {file_path}"
                        )));
                    } else {
                        return Err(WorktreeRouteError::Unprocessable(e.to_string()));
                    }
                }
            }
        }

        // File is tracked — run git diff HEAD
        let diff_output = Command::new("git")
            .current_dir(&wt_path)
            .args([
                "-c",
                "color.diff=false",
                "-c",
                "core.quotepath=false",
                "diff",
                "--no-color",
                "HEAD",
                "--",
                &rel_path,
            ])
            .output()
            .await
            .map_err(|e| WorktreeRouteError::Internal(format!("Failed to run git diff: {e}")))?;

        if !diff_output.status.success() && diff_output.status.code() != Some(1) {
            return Err(WorktreeRouteError::Internal(
                "git diff failed".to_string(),
            ));
        }

        let stdout = String::from_utf8_lossy(&diff_output.stdout);
        Ok(parse_diff_hunk(&stdout))
    }

    // Helper: locate project containing worktree
    async fn find_project_for_worktree(
        &self,
        wt_id: &str,
    ) -> Result<ProjectRecord, WorktreeRouteError> {
        let all = self.store.get_all_projects().await;
        for p in all {
            if p.worktrees.iter().any(|w| w.id == wt_id) {
                return Ok(p);
            }
        }
        Err(WorktreeRouteError::NotFound(format!(
            "Worktree '{wt_id}' not found"
        )))
    }

    async fn fetch_origin(&self, repo_path: &str, base_branch: &str) -> Result<(), ()> {
        let mut cmd = Command::new("git");
        cmd.args(["fetch", "origin", base_branch])
            .current_dir(repo_path)
            .env("GIT_TERMINAL_PROMPT", "0");
        let _ = cmd.output().await;
        Ok(())
    }
}

/// Parse unified diff output into line-level gutter marks.
/// Implements the block-flush algorithm: accumulate additions and deletions,
/// flush on context lines or new hunks, classifying blocks as added/deleted/modified.
pub fn parse_diff_hunk(diff_stdout: &str) -> GutterResult {
    let mut added = Vec::new();
    let mut deleted = Vec::new();
    let mut modified = Vec::new();

    let mut new_line: u32 = 0;
    let mut in_hunk: bool = false;
    let mut dels: u32 = 0;
    let mut adds: Vec<u32> = Vec::new();
    let mut block_start: u32 = 0;

    for line in diff_stdout.lines() {
        if line.starts_with("@@") {
            // Flush accumulated changes at hunk boundary
            flush_block(&mut dels, &mut adds, &mut modified, &mut added, &mut deleted, block_start);
            in_hunk = true;
            new_line = parse_new_start(line);
        } else if !in_hunk || line.starts_with('\\') {
            // Skip pre-hunk lines and "\ No newline at end of file"
            continue;
        } else if line.starts_with('+') {
            if dels == 0 && adds.is_empty() {
                block_start = new_line;
            }
            adds.push(new_line);
            new_line += 1;
        } else if line.starts_with('-') {
            if dels == 0 && adds.is_empty() {
                block_start = new_line;
            }
            dels += 1;
            // new_line is NOT advanced for a deletion
        } else {
            // Context line or other
            flush_block(&mut dels, &mut adds, &mut modified, &mut added, &mut deleted, block_start);
            new_line += 1;
        }
    }

    // Final flush in case diff ends mid-block
    flush_block(&mut dels, &mut adds, &mut modified, &mut added, &mut deleted, block_start);

    GutterResult {
        added,
        deleted,
        modified,
    }
}

/// Helper function to flush accumulated change blocks.
fn flush_block(
    dels: &mut u32,
    adds: &mut Vec<u32>,
    modified: &mut Vec<u32>,
    added: &mut Vec<u32>,
    deleted: &mut Vec<u32>,
    block_start: u32,
) {
    if *dels > 0 && !adds.is_empty() {
        // Replacement block: both adds and dels
        modified.extend(adds.iter());
    } else if !adds.is_empty() {
        // Pure insertion
        added.extend(adds.iter());
    } else if *dels > 0 {
        // Pure deletion
        deleted.push(block_start.saturating_sub(1));
    }
    *dels = 0;
    adds.clear();
}

/// Parse the "new" line number from a hunk header: `@@ -a,b +c,d @@`
/// Returns the line number after `+`, or 1 if parsing fails.
pub fn parse_new_start(hunk_line: &str) -> u32 {
    // Find the substring starting after '+' up to the next ',' or ' '
    if let Some(plus_pos) = hunk_line.find('+') {
        let after_plus = &hunk_line[plus_pos + 1..];
        let end_pos = after_plus
            .find(|c: char| c == ',' || c == ' ')
            .unwrap_or(after_plus.len());
        if let Ok(num) = after_plus[..end_pos].parse::<u32>() {
            return num;
        }
    }
    1 // Default to 1 on parse failure
}

#[derive(Debug)]
pub enum FileResponse {
    Text { etag: String, content: String },
    Image { mime: String, content: Vec<u8> },
}

#[derive(Debug)]
pub struct DiffResponse {
    pub etag: String,
    pub content: String,
}

/// Split `line` at byte offsets `start..end` into `(pre, mid, post)`,
/// then truncate the three fragments so the combined char-count stays
/// within `SNIP_MAX` (240). Public for unit-testing.
pub fn truncate_snippet(line: &str, start: usize, end: usize) -> (String, String, String) {
    const SNIP_LEAD: usize = 32;
    const SNIP_KEEP: usize = 16;
    const SNIP_MAX: usize = 240;

    // Byte-offset split — clamp to line length to avoid panic.
    let start = start.min(line.len());
    let end = end.min(line.len()).max(start);
    let raw_pre = &line[..start];
    let raw_mid = &line[start..end];
    let raw_post = &line[end..];

    // --- pre ---
    let mut pre: String = raw_pre.trim_start_matches([' ', '\t']).to_string();
    if pre.chars().count() > SNIP_LEAD {
        let keep: String = pre.chars().rev().take(SNIP_KEEP).collect::<Vec<_>>().into_iter().rev().collect();
        pre = format!("…{keep}");
    }

    // --- mid ---
    let mut mid: String = raw_mid.to_string();
    if mid.chars().count() > SNIP_MAX {
        mid = mid.chars().take(SNIP_MAX).collect::<String>() + "…";
    }

    // --- post ---
    let budget = SNIP_MAX.saturating_sub(pre.chars().count()).saturating_sub(mid.chars().count());
    let mut post: String = if budget > 0 {
        let p = raw_post.to_string();
        if p.chars().count() > budget {
            p.chars().take(budget).collect::<String>() + "…"
        } else {
            p
        }
    } else {
        String::new()
    };
    post = post.trim_end_matches([' ', '\t']).to_string();

    (pre, mid, post)
}

fn serialize_worktree_json(
    project_id: &str,
    w: &WorktreeRecord,
) -> serde_json::Map<String, serde_json::Value> {
    let main_session_id = w.sessions.iter().find(|s| s.is_main).map(|s| s.id.clone());
    let worktree = vst_types::rest::shared::Worktree {
        id: w.id.clone(),
        project_id: project_id.to_string(),
        name: w.name.clone(),
        branch: w.branch.clone(),
        branch_is_placeholder: w.branch_is_placeholder.unwrap_or(false),
        base_branch: w.base_branch.clone(),
        base_sha: w.base_sha.clone(),
        created_at: w.created_at.clone(),
        pinned_at: w.pinned_at.clone(),
        hidden_at: w.hidden_at.clone(),
        sort_order: w.sort_order,
        main_session_id,
    };
    serde_json::to_value(worktree)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_millis())
}

async fn get_fs_stat(mount_point: &str) -> Result<DiskDevice, WorktreeRouteError> {
    let output = Command::new("df")
        .args(["-k", "-P", mount_point])
        .output()
        .await;

    if let Ok(out) = output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = stdout.lines().collect();
            if lines.len() >= 2 {
                let parts: Vec<&str> = lines[1].split_whitespace().collect();
                // Format: Filesystem 1024-blocks Used Available Capacity Mounted_on
                if parts.len() >= 6 {
                    let total_1k: i64 = parts[1].parse().unwrap_or(0);
                    let used_1k: i64 = parts[2].parse().unwrap_or(0);
                    let avail_1k: i64 = parts[3].parse().unwrap_or(0);
                    let mount = parts[5].to_string();
                    return Ok(DiskDevice {
                        used_bytes: used_1k * 1024,
                        total_bytes: total_1k * 1024,
                        available_bytes: avail_1k * 1024,
                        mount_point: mount,
                    });
                }
            }
        }
    }

    Ok(DiskDevice {
        used_bytes: 0,
        total_bytes: 0,
        available_bytes: 0,
        mount_point: mount_point.to_string(),
    })
}

async fn dir_disk_usage(path: &Path) -> i64 {
    let mut cmd = Command::new("du");
    if cfg!(target_os = "macos") {
        cmd.arg("-sk");
    } else {
        cmd.arg("-sb");
    }
    cmd.arg(path);
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return 0,
    };
    if !output.status.success() {
        return 0;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.split('\t').next().unwrap_or("0");
    let num: i64 = first.trim().parse().unwrap_or(0);
    if cfg!(target_os = "macos") {
        num * 1024
    } else {
        num
    }
}
