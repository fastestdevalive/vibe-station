use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{watch, Mutex, RwLock};
use tracing::{debug, error, info, warn};
use vst_types::rest::lsp::{LspFileRef, LspStatus};
use vst_ws::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

use crate::client::{LspClient, LspClientError, ProgressKind};
use crate::registry::{self, LanguageServerConfig};

pub fn is_sensitive_path(path: &Path, vst_home: Option<&Path>) -> bool {
    let mut prefixes: Vec<PathBuf> = vec![
        PathBuf::from("/etc"),
        PathBuf::from("/root"),
    ];

    let home = std::env::var("HOME").ok().map(PathBuf::from);
    if let Some(h) = &home {
        prefixes.push(h.join(".ssh"));
        prefixes.push(h.join(".aws"));
        prefixes.push(h.join(".vibe-station"));
    }

    if let Some(vh) = vst_home {
        prefixes.push(vh.to_path_buf());
    }

    for prefix in prefixes {
        if path.starts_with(&prefix) {
            return true;
        }
        if let Ok(canon_prefix) = prefix.canonicalize() {
            if path.starts_with(&canon_prefix) {
                return true;
            }
        }
    }

    false
}

/// Resolves a `LspFileRef::Workspace` relative path against the worktree root,
/// enforcing path confinement so a request can never escape the worktree:
///
/// - An absolute path is rejected outright (an external file is reached via
///   `LspFileRef::External { token }`, never via a fake workspace path).
/// - The joined path is canonicalized, `root` is canonicalized the same way,
///   and the result must live under the canonicalized root — a `..`-escaping
///   relative path is rejected.
///
/// Deliberately does NOT call `is_sensitive_path` — that check exists for
/// paths reached OUTSIDE a workspace root (external-file serving, the
/// definition/references "is_internal" split), where `$VST_HOME` genuinely
/// needs blocking. A real worktree/project directory lives INSIDE
/// `$VST_HOME` (`~/.vibe-station/projects/<p>/worktrees/<w>/...`), so
/// applying that same check here would reject every legitimate in-workspace
/// file — root-confinement alone is the correct and sufficient guarantee for
/// this function: `root` is a directory the daemon already trusts, and
/// confinement to it excludes every sibling project/worktree/system path.
///
/// Returns `LspError::NotFound` when the path is rejected or doesn't resolve to
/// a file under the root.
pub fn resolve_workspace_path(root: &Path, rel_path: &str) -> Result<PathBuf, LspError> {
    let p = Path::new(rel_path);
    if p.is_absolute() {
        return Err(LspError::NotFound);
    }

    let joined = root.join(p);
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canon = joined.canonicalize().unwrap_or_else(|_| joined.clone());

    if !canon.starts_with(&canon_root) {
        return Err(LspError::NotFound);
    }

    Ok(canon)
}

struct ExternalTokenMap {
    tokens: HashMap<String, PathBuf>,
    paths: HashMap<PathBuf, String>,
    order: VecDeque<String>,
}

impl ExternalTokenMap {
    fn new() -> Self {
        Self {
            tokens: HashMap::new(),
            paths: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get_or_mint(&mut self, canonical_path: &Path) -> String {
        if let Some(existing) = self.paths.get(canonical_path) {
            return existing.clone();
        }

        let token = uuid::Uuid::new_v4().to_string();

        if self.tokens.len() >= 200 {
            while let Some(oldest) = self.order.pop_front() {
                if let Some(removed_path) = self.tokens.remove(&oldest) {
                    self.paths.remove(&removed_path);
                    break;
                }
            }
        }

        self.tokens.insert(token.clone(), canonical_path.to_path_buf());
        self.paths.insert(canonical_path.to_path_buf(), token.clone());
        self.order.push_back(token.clone());

        token
    }

    fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.tokens.get(token).cloned()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LspError {
    #[error("Language server not found")]
    NotFound,
    #[error("Language server still starting")]
    Starting,
    #[error("Language server timed out")]
    Timeout,
    #[error("Language server process died")]
    ProcessDied,
    #[error("LSP operation unsupported")]
    Unsupported,
    #[error("Unknown external token")]
    UnknownExternalToken,
    #[error("Code navigation is disabled for this workspace")]
    Disabled,
    #[error("Language server error: {0}")]
    ServerError(String),
}

impl From<LspClientError> for LspError {
    fn from(e: LspClientError) -> Self {
        match e {
            LspClientError::Timeout => LspError::Timeout,
            LspClientError::ChannelClosed => LspError::ProcessDied,
            LspClientError::RpcError { message, .. } => LspError::ServerError(message),
            other => LspError::ServerError(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkspaceKey {
    Worktree { project_id: String, worktree_id: String },
    Project { project_id: String },
}

impl WorkspaceKey {
    pub fn to_key_string(&self) -> String {
        match self {
            Self::Worktree { project_id, worktree_id } => format!("{}-{}", project_id, worktree_id),
            Self::Project { project_id } => project_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LspRequestKind {
    Definition,
    Hover,
    References,
    Outline,
}

#[derive(Debug, Clone)]
pub struct LocationTarget {
    pub abs_path: PathBuf,
    pub line: u32,
    pub character: u32,
    pub preview: String,
}

#[derive(Debug, Clone)]
pub struct ReferenceTarget {
    pub abs_path: PathBuf,
    pub line: u32,
    pub character: u32,
    pub preview: String,
    pub is_declaration: bool,
}

#[derive(Debug, Clone)]
pub enum LspResponse {
    Definition(Vec<LocationTarget>),
    Hover(Value),
    References(Vec<ReferenceTarget>),
    Outline(Value),
}

#[derive(Clone)]
pub struct ServerHandle {
    pub client: Arc<LspClient>,
    pub child: Arc<Mutex<Option<tokio::process::Child>>>,
    pub status: Arc<RwLock<LspStatus>>,
    pub last_request: Arc<RwLock<Instant>>,
    pub open_files: Arc<Mutex<HashSet<PathBuf>>>,
    pub file_versions: Arc<Mutex<HashMap<PathBuf, i64>>>,
    pub language: String,
    /// Latches to `true` once the `initialize` handshake has completed (the
    /// `initialize` response was received AND the `initialized` notification
    /// was sent). `request()` awaits this before sending `didOpen` or any
    /// request, because LSP-conformant servers (rust-analyzer 1.98.1 etc.)
    /// reject/crash on traffic sent before `initialized`.
    pub initialized: watch::Receiver<bool>,
}

pub struct LspManager {
    vst_home: PathBuf,
    servers: Arc<Mutex<HashMap<(WorkspaceKey, String), ServerHandle>>>,
    watchers: Arc<Mutex<HashMap<WorkspaceKey, Arc<FileWatcher>>>>,
    external_tokens: Arc<Mutex<HashMap<WorkspaceKey, ExternalTokenMap>>>,
    ever_ready: Mutex<HashSet<(WorkspaceKey, String)>>,
}

impl LspManager {
    pub fn new(vst_home: PathBuf) -> Arc<Self> {
        let mgr = Arc::new(Self {
            vst_home,
            servers: Arc::new(Mutex::new(HashMap::new())),
            watchers: Arc::new(Mutex::new(HashMap::new())),
            external_tokens: Arc::new(Mutex::new(HashMap::new())),
            ever_ready: Mutex::new(HashSet::new()),
        });

        // Spawn idle / stopped sweep task (Decision 3)
        let servers_clone = mgr.servers.clone();
        let watchers_clone = mgr.watchers.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                let mut servers_guard = servers_clone.lock().await;
                let mut stopped_workspaces = HashSet::new();

                for ((ws, _lang), handle) in servers_guard.iter_mut() {
                    let elapsed = handle.last_request.read().await.elapsed();
                    if elapsed >= Duration::from_secs(600) {
                        // 10 minutes: hard-stop (kill process)
                        let mut status = handle.status.write().await;
                        if *status != LspStatus::Stopped {
                            info!("Stopping language server for workspace {:?} (10m idle)", ws);
                            *status = LspStatus::Stopped;
                            let mut child_guard = handle.child.lock().await;
                            if let Some(mut child) = child_guard.take() {
                                let _ = child.kill().await;
                            }
                            stopped_workspaces.insert(ws.clone());
                        }
                    } else if elapsed >= Duration::from_secs(300) {
                        // 5 minutes: mark idle
                        let mut status = handle.status.write().await;
                        if *status == LspStatus::Ready {
                            debug!("Marking language server idle for workspace {:?}", ws);
                            *status = LspStatus::Idle;
                        }
                    }
                }

                // Clean up watchers for stopped workspaces
                if !stopped_workspaces.is_empty() {
                    let mut watchers_guard = watchers_clone.lock().await;
                    for ws in stopped_workspaces {
                        let mut all_stopped = true;
                        for ((k, _), h) in servers_guard.iter() {
                            if k == &ws && *h.status.read().await != LspStatus::Stopped {
                                all_stopped = false;
                                break;
                            }
                        }
                        if all_stopped {
                            if let Some(watcher) = watchers_guard.remove(&ws) {
                                watcher.close();
                            }
                        }
                    }
                }
            }
        });

        mgr
    }

    /// Query the LSP status for a given workspace and file path (or extension).
    pub async fn status(&self, workspace: &WorkspaceKey, path: &str, enabled: bool) -> (LspStatus, Option<String>) {
        let ext = Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(path);

        let Some(cfg) = registry::lookup(ext) else {
            return if !enabled {
                (LspStatus::Disabled, None)
            } else {
                (LspStatus::Unsupported, None)
            };
        };

        let lang = cfg.language.to_string();

        if !enabled {
            return (LspStatus::Disabled, Some(lang));
        }

        let servers = self.servers.lock().await;
        if let Some(handle) = servers.get(&(workspace.clone(), lang.clone())) {
            let status = *handle.status.read().await;
            return (status, Some(lang));
        }

        // Check if command is on PATH
        if !binary_on_path(cfg.command) {
            return (LspStatus::NotFound, Some(lang));
        }

        (LspStatus::Stopped, Some(lang))
    }

    /// Host-wide survey of every registered language server: whether its
    /// command is on the daemon host's PATH, plus a runnable install command
    /// / note for the missing ones. No workspace resolution, no async I/O
    /// beyond a `$PATH` scan — infallible.
    pub fn language_survey(&self) -> Vec<vst_types::rest::lsp::LspLanguageSurveyEntry> {
        registry::all()
            .iter()
            .map(|cfg| vst_types::rest::lsp::LspLanguageSurveyEntry {
                language: cfg.language.to_string(),
                display_name: cfg.display_name.to_string(),
                command: cfg.command.to_string(),
                installed_on_host: binary_on_path(cfg.command),
                install_command: cfg.install_command.map(|s| s.to_string()),
                install_note: cfg.install_note.map(|s| s.to_string()),
            })
            .collect()
    }

    /// For tests: manually insert a ServerHandle
    pub async fn insert_server_handle(&self, key: WorkspaceKey, lang: String, handle: ServerHandle) {
        self.servers.lock().await.insert((key, lang), handle);
    }

    /// For tests: get a ServerHandle
    pub async fn get_server_handle(&self, key: &WorkspaceKey, lang: &str) -> Option<ServerHandle> {
        self.servers.lock().await.get(&(key.clone(), lang.to_string())).cloned()
    }

    /// For tests: insert an Arc<FileWatcher>
    pub async fn insert_watcher(&self, key: WorkspaceKey, watcher: Arc<FileWatcher>) {
        self.watchers.lock().await.insert(key, watcher);
    }

    /// For tests: get a watcher
    pub async fn get_watcher(&self, key: &WorkspaceKey) -> Option<Arc<FileWatcher>> {
        self.watchers.lock().await.get(key).cloned()
    }

    pub async fn get_or_mint_external_token(&self, workspace: &WorkspaceKey, canonical_path: &Path) -> String {
        let mut tokens_map = self.external_tokens.lock().await;
        let entry = tokens_map.entry(workspace.clone()).or_insert_with(ExternalTokenMap::new);
        entry.get_or_mint(canonical_path)
    }

    pub async fn resolve_external_token(&self, workspace: &WorkspaceKey, token: &str) -> Option<PathBuf> {
        let tokens_map = self.external_tokens.lock().await;
        tokens_map.get(workspace).and_then(|m| m.resolve(token))
    }

    /// For tests: directly insert an external token mapping
    pub async fn insert_external_token(&self, workspace: WorkspaceKey, token: String, path: PathBuf) {
        let mut tokens_map = self.external_tokens.lock().await;
        let entry = tokens_map.entry(workspace).or_insert_with(ExternalTokenMap::new);
        entry.tokens.insert(token.clone(), path.clone());
        entry.paths.insert(path, token.clone());
        entry.order.push_back(token);
    }

    pub async fn has_ever_been_ready(&self, workspace: &WorkspaceKey, lang: &str) -> bool {
        self.ever_ready
            .lock()
            .await
            .contains(&(workspace.clone(), lang.to_string()))
    }

    pub async fn request(
        &self,
        workspace: WorkspaceKey,
        root: &Path,
        lang: &str,
        file: LspFileRef,
        kind: LspRequestKind,
        pos: Option<(u32, u32)>,
        enabled: bool,
    ) -> Result<LspResponse, LspError> {
        if !enabled {
            return Err(LspError::Disabled);
        }

        let (abs_path, uri) = match file {
            LspFileRef::Workspace { path: rel_path } => {
                // Path confinement: reject absolute / escaping / sensitive paths
                // (they'd let the language server open any readable host file).
                let canon = resolve_workspace_path(root, &rel_path)?;
                let uri = format!("file://{}", canon.display());
                (canon, uri)
            }
            LspFileRef::External { token } => {
                let canon = self
                    .resolve_external_token(&workspace, &token)
                    .await
                    .ok_or(LspError::UnknownExternalToken)?;

                if !canon.is_file() || is_sensitive_path(&canon, Some(&self.vst_home)) {
                    return Err(LspError::UnknownExternalToken);
                }

                let ext = canon.extension().and_then(|s| s.to_str()).unwrap_or("");
                let file_cfg = registry::lookup(ext);
                if let Some(cfg) = file_cfg {
                    if cfg.language != lang {
                        return Err(LspError::Unsupported);
                    }
                } else {
                    return Err(LspError::Unsupported);
                }

                let uri = format!("file://{}", canon.display());
                (canon, uri)
            }
        };

        // 1. Look up or lazily spawn ServerHandle for (workspace, lang) — spawn-on-first-use.
        let handle = self.ensure_server_handle(&workspace, root, lang).await?;

        // 1.5. Wait for the initialize handshake to complete before sending
        // didOpen or any request. Sending traffic before `initialized` crashes
        // LSP-conformant servers (rust-analyzer exits with "expected initialized
        // notification"), which previously left status stuck at Starting forever.
        if !*handle.initialized.borrow() {
            // Resolves when the latch is set true, or returns Err if the init
            // task ended without completing (the handle's status will be Error).
            let _ = handle.initialized.clone().changed().await;
        }
        if *handle.status.read().await == LspStatus::Error {
            return Err(LspError::ProcessDied);
        }

        // 2. Ensure a didOpen has been sent for that URI on this handle
        {
            let mut open_files = handle.open_files.lock().await;
            if !open_files.contains(&abs_path) {
                let content = tokio::fs::read_to_string(&abs_path).await.unwrap_or_default();
                let did_open = json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": lang,
                        "version": 1,
                        "text": content
                    }
                });
                let _ = handle.client.notify("textDocument/didOpen", did_open);
                open_files.insert(abs_path.clone());
                handle.file_versions.lock().await.insert(abs_path.clone(), 1);
            }
        }

        // 3. If ServerHandle.status is Starting or Indexing, return LspError::Starting immediately
        let current_status = *handle.status.read().await;
        if current_status == LspStatus::Starting || current_status == LspStatus::Indexing {
            return Err(LspError::Starting);
        }
        if current_status == LspStatus::Idle {
            *handle.status.write().await = LspStatus::Ready;
        }
        self.ever_ready
            .lock()
            .await
            .insert((workspace.clone(), lang.to_string()));
        *handle.last_request.write().await = Instant::now();

        // 5. Forward the LSP request over the handle's JSON-RPC client, await with 10s timeout
        match kind {
            LspRequestKind::Definition => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character }
                });
                let res = handle.client.request("textDocument/definition", params).await?;
                let locations = parse_definition_response(res).await;
                Ok(LspResponse::Definition(locations))
            }
            LspRequestKind::Hover => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character }
                });
                let res = handle.client.request("textDocument/hover", params).await?;
                Ok(LspResponse::Hover(res))
            }
            LspRequestKind::References => {
                let (line, character) = pos.unwrap_or((0, 0));
                let params = json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character },
                    "context": { "includeDeclaration": true }
                });
                let res = handle.client.request("textDocument/references", params).await?;
                let targets = parse_references_response(res, Some(&abs_path), pos).await;
                Ok(LspResponse::References(targets))
            }
            LspRequestKind::Outline => {
                let params = json!({
                    "textDocument": { "uri": uri }
                });
                let res = handle.client.request("textDocument/documentSymbol", params).await?;
                Ok(LspResponse::Outline(res))
            }
        }
    }

    async fn ensure_server_handle(
        &self,
        workspace: &WorkspaceKey,
        root: &Path,
        lang: &str,
    ) -> Result<ServerHandle, LspError> {
        let mut servers = self.servers.lock().await;
        let key = (workspace.clone(), lang.to_string());

        if let Some(handle) = servers.get(&key) {
            let status = *handle.status.read().await;
            if status != LspStatus::Stopped && status != LspStatus::Error {
                return Ok(handle.clone());
            }
        }

        // Must spawn new server
        let cfg = registry::lookup_by_language(lang)
            .or_else(|| registry::lookup(lang))
            .ok_or(LspError::Unsupported)?;

        // Kill any stale/errored process before replacing the handle, so the
        // old Child doesn't leak (it would otherwise just be dropped).
        if let Some(old) = servers.remove(&key) {
            if let Some(mut child) = old.child.lock().await.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let handle = self.spawn_server(workspace, root, cfg).await?;
        servers.insert(key, handle.clone());

        // Ensure file watcher is spawned for this workspace (Decision 9)
        self.ensure_watcher(workspace, root).await;

        Ok(handle)
    }

    async fn spawn_server(
        &self,
        workspace: &WorkspaceKey,
        root: &Path,
        cfg: &LanguageServerConfig,
    ) -> Result<ServerHandle, LspError> {
        let mut cmd = tokio::process::Command::new(cfg.command);
        cmd.args(&cfg.args);
        cmd.current_dir(root);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::null());
        // Backstop: kill the child if the handle/child is dropped without an
        // explicit kill (e.g. a stale handle replaced in ensure_server_handle).
        cmd.kill_on_drop(true);

        for (k, v) in &cfg.extra_env {
            cmd.env(k, v);
        }

        // Decision 3: dedicated CARGO_TARGET_DIR for rust-analyzer
        if cfg.language == "rust" {
            let target_dir = self.vst_home.join("lsp-target").join(workspace.to_key_string());
            let _ = tokio::fs::create_dir_all(&target_dir).await;
            cmd.env("CARGO_TARGET_DIR", target_dir);
        }

        // Decision 11: Java's per-workspace -data directory
        if cfg.language == "java" {
            let data_dir = self.vst_home.join("lsp-jdtls-data").join(workspace.to_key_string());
            let _ = tokio::fs::create_dir_all(&data_dir).await;
            cmd.arg("-data").arg(&data_dir);
        }

        // Decision 3: lowered scheduling priority via libc::setpriority
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                Ok(())
            });
        }

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                LspError::NotFound
            } else {
                LspError::ServerError(e.to_string())
            }
        })?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        let (client, mut progress_rx) = LspClient::new(stdout, stdin);
        let status = Arc::new(RwLock::new(LspStatus::Starting));
        let last_request = Arc::new(RwLock::new(Instant::now()));
        let open_files = Arc::new(Mutex::new(HashSet::new()));
        let file_versions = Arc::new(Mutex::new(HashMap::new()));
        let child_arc = Arc::new(Mutex::new(Some(child)));

        let (init_tx, init_rx) = watch::channel(false);

        let handle = ServerHandle {
            client: client.clone(),
            child: child_arc,
            status: status.clone(),
            last_request,
            open_files,
            file_versions,
            language: cfg.language.to_string(),
            initialized: init_rx,
        };

        // Decision 3-bis: initialize + progress tracking
        let client_clone = client.clone();
        let status_clone = status.clone();
        let root_buf = root.to_path_buf();
        let init_options = cfg.init_options.clone();

        tokio::spawn(async move {
            match client_clone.initialize(&root_buf, init_options).await {
                Ok(_) => {
                    debug!("LSP initialized successfully");
                    // The initialize response was received and the `initialized`
                    // notification has been sent — release request()/didOpen.
                    let _ = init_tx.send(true);
                }
                Err(e) => {
                    error!("LSP initialize failed: {e}");
                    *status_clone.write().await = LspStatus::Error;
                    // Drop init_tx so any request() awaiting the latch unblocks
                    // (then sees status == Error and fails fast).
                    drop(init_tx);
                    let _ = client_clone.fail_pending().await;
                    return;
                }
            }

            let mut active_tokens = HashSet::new();
            let mut saw_progress = false;
            let mut settled = false;
            let settle_delay = tokio::time::sleep(Duration::from_secs(2));
            tokio::pin!(settle_delay);

            loop {
                tokio::select! {
                    progress = progress_rx.recv() => {
                        match progress {
                            Some(p) => {
                                saw_progress = true;
                                match p.kind {
                                    ProgressKind::Begin => {
                                        active_tokens.insert(format!("{:?}", p.token));
                                        *status_clone.write().await = LspStatus::Indexing;
                                    }
                                    ProgressKind::Report => {}
                                    ProgressKind::End => {
                                        active_tokens.remove(&format!("{:?}", p.token));
                                        if active_tokens.is_empty() {
                                            *status_clone.write().await = LspStatus::Ready;
                                        }
                                    }
                                }
                            }
                            None => {
                                // progress channel closed = the reader task hit
                                // EOF / an I/O error = the child process died.
                                break;
                            }
                        }
                    }
                    _ = &mut settle_delay, if !saw_progress && !settled => {
                        // Fire at most once: a fired-but-not-reset sleep future
                        // resolves immediately on every poll, which would spin
                        // this loop at 100% CPU if the guard stayed true.
                        settled = true;
                        let mut s = status_clone.write().await;
                        if *s == LspStatus::Starting {
                            *s = LspStatus::Ready;
                        }
                    }
                }
            }

            // Reader task ended (child died / EOF). Mark the server Error so
            // requests stop being routed to a dead process, and fail any
            // requests still awaiting a response.
            *status_clone.write().await = LspStatus::Error;
            let _ = client_clone.fail_pending().await;
        });

        Ok(handle)
    }

    async fn ensure_watcher(&self, workspace: &WorkspaceKey, root: &Path) {
        let mut watchers = self.watchers.lock().await;
        if watchers.contains_key(workspace) {
            return;
        }

        let servers_clone = self.servers.clone();
        let ws_key_clone = workspace.clone();
        let on_changed = Arc::new(move |abs_path_str: String| {
            let servers = servers_clone.clone();
            let ws_key = ws_key_clone.clone();
            tokio::spawn(async move {
                let abs_path = PathBuf::from(&abs_path_str);
                let guard = servers.lock().await;
                for ((ws, _), handle) in guard.iter() {
                    if ws == &ws_key {
                        let is_open = handle.open_files.lock().await.contains(&abs_path);
                        if is_open {
                            if let Ok(content) = tokio::fs::read_to_string(&abs_path).await {
                                let mut versions = handle.file_versions.lock().await;
                                let ver = versions.entry(abs_path.clone()).or_insert(1);
                                *ver += 1;
                                let uri = format!("file://{}", abs_path.display());
                                let _ = handle.client.notify(
                                    "textDocument/didChange",
                                    json!({
                                        "textDocument": {
                                            "uri": uri,
                                            "version": *ver
                                        },
                                        "contentChanges": [
                                            { "text": content }
                                        ]
                                    }),
                                );
                            }
                        } else {
                            let uri = format!("file://{}", abs_path.display());
                            let _ = handle.client.notify(
                                "workspace/didChangeWatchedFiles",
                                json!({
                                    "changes": [
                                        { "uri": uri, "type": 2 }
                                    ]
                                }),
                            );
                        }
                    }
                }
            });
        });

        let servers_clone_del = self.servers.clone();
        let ws_key_clone_del = workspace.clone();
        let on_deleted = Arc::new(move |abs_path_str: String| {
            let servers = servers_clone_del.clone();
            let ws_key = ws_key_clone_del.clone();
            tokio::spawn(async move {
                let abs_path = PathBuf::from(&abs_path_str);
                let guard = servers.lock().await;
                for ((ws, _), handle) in guard.iter() {
                    if ws == &ws_key {
                        let uri = format!("file://{}", abs_path.display());
                        let _ = handle.client.notify(
                            "workspace/didChangeWatchedFiles",
                            json!({
                                "changes": [
                                    { "uri": uri, "type": 3 }
                                ]
                            }),
                        );
                    }
                }
            });
        });

        let callbacks = WatcherCallbacks {
            on_changed,
            on_deleted,
            on_error: Arc::new(|err| warn!("LSP FileWatcher error: {err}")),
        };

        let root_buf = root.to_path_buf();
        let watcher = Arc::new(FileWatcher::new(callbacks, root_buf.clone()));
        let watcher_clone = watcher.clone();
        let root_str = root_buf.to_string_lossy().into_owned();

        let _ = tokio::task::spawn_blocking(move || {
            let _ = watcher_clone.spawn(&root_str);
        })
        .await;

        watchers.insert(workspace.clone(), watcher);
    }
}

fn binary_on_path(cmd: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let full = dir.join(cmd);
            if full.is_file() {
                return true;
            }
        }
    }
    false
}

async fn parse_definition_response(val: Value) -> Vec<LocationTarget> {
    let mut targets = Vec::new();

    let items = if val.is_null() {
        vec![]
    } else if let Some(arr) = val.as_array() {
        arr.clone()
    } else {
        vec![val]
    };

    for item in items {
        // Can be Location { uri, range: { start: { line, character } } }
        // or LocationLink { targetUri, targetSelectionRange | targetRange }
        let uri_str = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(|u| u.as_str());

        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("targetRange"));

        let start = range.and_then(|r| r.get("start"));
        let line = start.and_then(|s| s.get("line")).and_then(|l| l.as_u64()).unwrap_or(0) as u32;
        let character = start.and_then(|s| s.get("character")).and_then(|c| c.as_u64()).unwrap_or(0) as u32;

        if let Some(uri) = uri_str {
            let path_str = uri.strip_prefix("file://").unwrap_or(uri);
            let abs_path = PathBuf::from(path_str);
            let preview = read_line_preview(&abs_path, line as usize).await;
            targets.push(LocationTarget {
                abs_path,
                line,
                character,
                preview,
            });
        }
    }

    targets
}

async fn parse_references_response(
    val: Value,
    req_path: Option<&Path>,
    req_pos: Option<(u32, u32)>,
) -> Vec<ReferenceTarget> {
    let mut targets = Vec::new();

    let items = if val.is_null() {
        vec![]
    } else if let Some(arr) = val.as_array() {
        arr.clone()
    } else {
        vec![val]
    };

    for item in items {
        let uri_str = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(|u| u.as_str());

        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("targetRange"));

        let start = range.and_then(|r| r.get("start"));
        let line = start.and_then(|s| s.get("line")).and_then(|l| l.as_u64()).unwrap_or(0) as u32;
        let character = start.and_then(|s| s.get("character")).and_then(|c| c.as_u64()).unwrap_or(0) as u32;

        let is_declaration = item
            .get("isDeclaration")
            .and_then(|b| b.as_bool())
            .or_else(|| {
                if let (Some(rp), Some((rl, rc))) = (req_path, req_pos) {
                    if let Some(uri) = uri_str {
                        let path_str = uri.strip_prefix("file://").unwrap_or(uri);
                        let abs_path = PathBuf::from(path_str);
                        if abs_path == rp && line == rl && character == rc {
                            return Some(true);
                        }
                    }
                }
                None
            })
            .unwrap_or(false);

        if let Some(uri) = uri_str {
            let path_str = uri.strip_prefix("file://").unwrap_or(uri);
            let abs_path = PathBuf::from(path_str);
            let preview = read_line_preview(&abs_path, line as usize).await;
            targets.push(ReferenceTarget {
                abs_path,
                line,
                character,
                preview,
                is_declaration,
            });
        }
    }

    targets
}

async fn read_line_preview(path: &Path, line: usize) -> String {
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        if let Some(l) = content.lines().nth(line) {
            return l.trim().to_string();
        }
    }
    String::new()
}
